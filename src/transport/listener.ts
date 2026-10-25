import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_LISTEN_HOST, DEFAULT_LISTEN_PORT } from '../constants.js';
import { trimSlashes, type NestMcpAuthorize } from '../nest-mcp.options.js';

/** Where the listener binds. */
export interface ListenAddress {
  host: string;
  port: number;
}

/** One instance's route on the listener. */
export interface ListenerEndpoint {
  /** Normalised: no leading or trailing slashes; `''` is `/`. */
  path: string;
  authorize: NestMcpAuthorize | undefined;
  /** The `listen` option the instance was given; `undefined` takes the others' or the default. */
  listen: Partial<ListenAddress> | undefined;
  /** Answers a `POST` that passed `authorize`. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Reports what the listener could not hand to `handle` (a failing `authorize`). */
  onError(message: string): void;
}

export function jsonRpcError(
  res: ServerResponse,
  status: number,
  message: string,
  code = -32000,
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '0:0:0:0:0:0:0:1']);

/** Whether binding to `host` keeps the listener reachable from this machine only. */
export function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  return LOOPBACK_HOSTS.has(bare) || /^(::ffff:)?127\./.test(bare);
}

/** `http://host:port` of a bound server; a wildcard bind is reported as `localhost`. */
export function origin(address: AddressInfo): string {
  const wildcard = address.address === '::' || address.address === '0.0.0.0';
  const host = wildcard
    ? 'localhost'
    : address.address.includes(':')
      ? `[${address.address}]`
      : address.address;
  return `http://${host}:${address.port}`;
}

function describe(listen: ListenAddress): string {
  return `${listen.host}:${listen.port}`;
}

function sameAddress(a: ListenAddress, b: ListenAddress): boolean {
  return a.host === b.host && a.port === b.port;
}

function withDefaults(listen: Partial<ListenAddress>): ListenAddress {
  return { host: listen.host ?? DEFAULT_LISTEN_HOST, port: listen.port ?? DEFAULT_LISTEN_PORT };
}

function listenError(error: NodeJS.ErrnoException, address: ListenAddress): Error {
  if (error.code === 'EADDRINUSE') {
    return new Error(
      `NestMcpModule: the inspector cannot listen on ${describe(address)}: the port is already in ` +
        'use. Set `listen.port` to a free port, for example ' +
        'NestMcpModule.forRoot({ listen: { port: 7778 } }).',
    );
  }
  return new Error(
    `NestMcpModule: the inspector cannot listen on ${describe(address)} (${error.code ?? error.message}). ` +
      'Check `listen.host` and `listen.port`.',
  );
}

/**
 * The inspector's own HTTP server for one app, shared by every instance mounted in it. Instances
 * join while the app initialises; the first to bootstrap opens it, and it closes when the last one
 * leaves. Nothing of the app (prefix, versioning, middlewares, enhancers) runs in front of it.
 */
export class InspectorListener {
  private readonly endpoints = new Map<string, ListenerEndpoint>();
  private given: ListenAddress | undefined;
  private server: Server | undefined;
  private opening: Promise<string> | undefined;

  /** Adds an instance's route. Throws on a path taken or on a `listen` other instances contradict. */
  join(endpoint: ListenerEndpoint): void {
    if (this.endpoints.has(endpoint.path)) {
      throw new Error(
        `NestMcpModule: two instances answer at /${endpoint.path} on the inspector listener. ` +
          'Give each instance its own `path`.',
      );
    }
    if (endpoint.listen) {
      const listen = withDefaults(endpoint.listen);
      if (this.given && !sameAddress(this.given, listen)) {
        throw new Error(
          'NestMcpModule: every instance of an app shares one inspector listener, but two ' +
            `instances set different \`listen\` options (${describe(this.given)} and ` +
            `${describe(listen)}). Set \`listen\` on one instance only, or the same on all.`,
        );
      }
      this.given = listen;
    }
    this.endpoints.set(endpoint.path, endpoint);
  }

  /** The address the listener binds, once every instance has joined. */
  address(): ListenAddress {
    return this.given ?? withDefaults({});
  }

  /** Opens the listener the first time it is called; resolves with its origin. */
  open(): Promise<string> {
    this.opening ??= this.start();
    return this.opening;
  }

  /** Removes an instance's route; the last one to leave closes the listener. */
  async leave(path: string): Promise<void> {
    this.endpoints.delete(path);
    if (this.endpoints.size > 0 || !this.server) return;
    const server = this.server;
    this.server = undefined;
    this.opening = undefined;
    // Clients keep connections alive; without this, `close` waits for them to time out.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private start(): Promise<string> {
    const address = this.address();
    const server = createServer((req, res) => {
      this.dispatch(req, res).catch(() => {
        if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error', -32603);
      });
    });
    return new Promise<string>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        this.opening = undefined;
        reject(listenError(error, address));
      });
      server.listen(address.port, address.host, () => {
        this.server = server;
        resolve(origin(server.address() as AddressInfo));
      });
    });
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The raw request target, query string dropped; no URL parsing, so `//x` is not a host.
    const path = trimSlashes((req.url ?? '/').split('?')[0] ?? '');
    const endpoint = this.endpoints.get(path);
    if (!endpoint) {
      jsonRpcError(res, 404, `No inspector endpoint at /${path}.`);
      return;
    }
    if (endpoint.authorize && !(await this.authorized(endpoint, req))) {
      jsonRpcError(res, 403, 'Forbidden: the inspector refused this request (`authorize`).');
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      jsonRpcError(res, 405, 'Method not allowed: this MCP endpoint is stateless, use POST.');
      return;
    }
    await endpoint.handle(req, res);
  }

  private async authorized(endpoint: ListenerEndpoint, req: IncomingMessage): Promise<boolean> {
    try {
      return (await endpoint.authorize!(req)) === true;
    } catch (error) {
      endpoint.onError(
        `/${endpoint.path}: authorize threw, the request was refused: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}

/** One listener per app, found by an object unique to the app (its `ModulesContainer`). */
const listeners = new WeakMap<object, InspectorListener>();

export function listenerFor(app: object): InspectorListener {
  let listener = listeners.get(app);
  if (!listener) {
    listener = new InspectorListener();
    listeners.set(app, listener);
  }
  return listener;
}
