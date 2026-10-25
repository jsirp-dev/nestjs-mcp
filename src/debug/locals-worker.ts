/**
 * The locals worker (ADR-0005): a worker thread whose inspector session, connected to the main
 * thread, pauses it at every exception, reads the scopes of the frames that threw when the
 * exception is the app's and a trace or a run is in flight, posts what it read and resumes. It
 * never evaluates anything in the app. Started by `LocalsCapture`, built as its own file.
 */
import { Session } from 'node:inspector';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import {
  captureFrames,
  isRethrow,
  type CallFrame,
  type CapturedFrame,
  type LocalsBounds,
  type PropertyDescriptor,
  type RemoteObject,
} from './locals-preview.js';

export interface LocalsWorkerData {
  /** `[0]`: traces and runs in flight, kept by the main thread. */
  inFlight: Int32Array;
  /** Where captures go; the main thread drains it synchronously. */
  port: MessagePort;
  /** This package's own directory: its frames are never the app's. */
  ownDir: string;
  bounds: LocalsBounds;
  perMinute: number;
}

/** What the worker posts on `port`, keyed by the exception's stack text. */
export type LocalsMessage =
  { key: string; frames: CapturedFrame[]; truncated?: true } | { key: string; skipped: 'rate' };

/** What the worker posts on `parentPort`. */
export type LocalsStatusMessage = { ready: true } | { failed: string };

/** A capture may hold the main thread this long at most. */
const CAPTURE_TIMEOUT_MS = 200;

interface PausedParams {
  reason: string;
  data?: RemoteObject;
  callFrames: CallFrame[];
}

function start(input: LocalsWorkerData): void {
  const session = new Session();
  session.connectToMainThread();
  const post = <T>(method: string, params?: object) =>
    new Promise<T>((resolve, reject) => {
      session.post(method, params, (error, result) =>
        error ? reject(error) : resolve(result as T),
      );
    });
  const getProperties = async (objectId: string) =>
    (
      await post<{ result: PropertyDescriptor[] }>('Runtime.getProperties', {
        objectId,
        ownProperties: true,
      })
    ).result;

  const files = new Map<string, string>();
  session.on('Debugger.scriptParsed', (message: { params: { scriptId: string; url: string } }) => {
    if (message.params.url) files.set(message.params.scriptId, toPath(message.params.url));
  });
  const fileOf = (scriptId: string) => files.get(scriptId);
  const ownDir = input.ownDir.endsWith(sep) ? input.ownDir : `${input.ownDir}${sep}`;
  const isApp = (file: string | undefined) =>
    file !== undefined &&
    !file.startsWith('node:') &&
    !/[\\/]node_modules[\\/]/.test(file) &&
    !file.startsWith(ownDir) &&
    /[\\/]/.test(file);

  const recent: number[] = [];
  const withinRate = () => {
    const now = Date.now();
    while (recent.length > 0 && now - recent[0]! >= 60_000) recent.shift();
    if (recent.length >= input.perMinute) return false;
    recent.push(now);
    return true;
  };

  const capture = async (params: PausedParams) => {
    if (Atomics.load(input.inFlight, 0) <= 0) return;
    const { data } = params;
    if (data?.subtype !== 'error' || typeof data.description !== 'string') return;
    const top = params.callFrames[0];
    if (!top || !isApp(fileOf(top.location.scriptId))) return;
    const key = data.description;
    if (await isRethrow(top, key, getProperties)) return;
    if (!withinRate()) {
      input.port.postMessage({ key, skipped: 'rate' } satisfies LocalsMessage);
      return;
    }
    const captured = await captureFrames({
      callFrames: params.callFrames,
      fileOf,
      isApp,
      getProperties,
      bounds: input.bounds,
      timeoutMs: CAPTURE_TIMEOUT_MS,
    });
    input.port.postMessage({ key, ...captured } satisfies LocalsMessage);
  };

  session.on('Debugger.paused', (message: { params: PausedParams }) => {
    const { params } = message;
    // Any other pause (a breakpoint of another debugger) is not this session's to resume.
    if (params.reason !== 'exception' && params.reason !== 'promiseRejection') return;
    capture(params)
      .catch(() => undefined)
      .finally(() => {
        post('Debugger.resume').catch(() => undefined);
      });
  });

  (async () => {
    await post('Debugger.enable');
    // A `debugger` statement in the app must not stop it because this session is attached.
    await post('Debugger.setBreakpointsActive', { active: false });
    await post('Debugger.setPauseOnExceptions', { state: 'all' });
  })().then(
    () => parentPort?.postMessage({ ready: true } satisfies LocalsStatusMessage),
    (error: unknown) =>
      parentPort?.postMessage({ failed: String(error) } satisfies LocalsStatusMessage),
  );
  // The session alone does not keep a worker alive.
  parentPort?.on('message', () => undefined);
}

function toPath(url: string): string {
  if (!url.startsWith('file:')) return url;
  try {
    return fileURLToPath(url);
  } catch {
    return url;
  }
}

if (parentPort && workerData) start(workerData as LocalsWorkerData);
