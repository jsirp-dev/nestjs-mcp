import type {
  ClassKind,
  GraphClass,
  GraphEdge,
  GraphEnhancer,
  GraphModel,
  GraphModule,
  GraphUnavailable,
  ProviderScope,
} from './model.js';

/** What the reader needs from Nest's `SerializedGraph`. Duck-typed on purpose. */
export interface SerializedGraphLike {
  toJSON(): { nodes?: Record<string, unknown>; edges?: Record<string, unknown> };
}

interface RawNode {
  id: string;
  label: unknown;
  parent?: string;
  metadata: Record<string, unknown> & { type: string };
}

interface RawEdge {
  source: string;
  target: string;
  metadata: Record<string, unknown> & { type: string };
}

const CLASS_KINDS: readonly ClassKind[] = ['provider', 'controller', 'injectable', 'middleware'];

/** A token as text: a class or function by its name, a symbol by its description. */
export function tokenText(token: unknown): string {
  if (typeof token === 'function') return token.name || 'anonymous';
  if (typeof token === 'symbol') return token.description ?? token.toString();
  return String(token);
}

/** Nest's `Scope` enum (0 default, 1 transient, 2 request), or the flags Nest also records. */
function providerScope(metadata: Record<string, unknown>): ProviderScope {
  if (metadata.scope === 2) return 'REQUEST';
  if (metadata.scope === 1 || metadata.transient === true) return 'TRANSIENT';
  if (metadata.scope === 0 || metadata.static !== false) return 'DEFAULT';
  return 'REQUEST';
}

function optionalText(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : tokenText(value);
}

/** Module names, suffixed `#n` in graph order only where several modules share one. */
function moduleNames(nodes: RawNode[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const name = tokenText(node.label);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const names = new Map<string, string>();
  for (const node of nodes) {
    const name = tokenText(node.label);
    if ((counts.get(name) ?? 0) < 2) {
      names.set(node.id, name);
      continue;
    }
    const ordinal = (seen.get(name) ?? 0) + 1;
    seen.set(name, ordinal);
    names.set(node.id, `${name}#${ordinal}`);
  }
  return names;
}

/**
 * Reads Nest's serialized graph and maps it to the package's model. Reads on every call: the
 * graph is complete only after `app.init()`, and `toJSON()` is a cheap shallow copy.
 */
export class GraphReader {
  constructor(private readonly serializedGraph: SerializedGraphLike | undefined) {}

  /**
   * The graph id of the module that declares a provider under exactly this token (compared by
   * identity, before it is turned into text), or `undefined` when no node has it.
   */
  moduleDeclaring(token: unknown): string | undefined {
    const nodes = Object.values(this.serializedGraph?.toJSON().nodes ?? {}) as RawNode[];
    return nodes.find((node) => node.metadata.type === 'provider' && node.metadata.token === token)
      ?.parent;
  }

  read(): GraphModel | GraphUnavailable {
    const json = this.serializedGraph?.toJSON();
    const rawNodes = Object.values(json?.nodes ?? {}) as RawNode[];
    if (rawNodes.length === 0) return { unavailable: 'snapshot_disabled' };

    const moduleNodes = rawNodes.filter((node) => node.metadata.type === 'module');
    const names = moduleNames(moduleNodes);
    const modules: Record<string, GraphModule> = {};
    for (const node of moduleNodes) {
      modules[node.id] = {
        id: node.id,
        name: names.get(node.id)!,
        global: node.metadata.global === true,
        dynamic: node.metadata.dynamic === true,
        internal: node.metadata.internal === true,
        imports: [],
        exports: [],
        providers: [],
        controllers: [],
      };
    }

    const classes: Record<string, GraphClass> = {};
    const classNodes = rawNodes.filter(
      (node) => CLASS_KINDS.includes(node.metadata.type as ClassKind) && node.parent! in modules,
    );
    for (const node of classNodes) {
      const metadata = node.metadata;
      const entry: GraphClass = {
        id: node.id,
        name: tokenText(metadata.token ?? node.label),
        kind: metadata.type as ClassKind,
        module: node.parent!,
        scope: providerScope(metadata),
        durable: metadata.durable === true,
        exported: metadata.exported === true,
        internal: metadata.internal === true || modules[node.parent!]!.internal,
        token: tokenText(metadata.token ?? node.label),
        initTimeMs: typeof metadata.initTime === 'number' ? metadata.initTime : 0,
      };
      if (metadata.subtype !== undefined) entry.subtype = String(metadata.subtype);
      if (metadata.global === true) entry.global = true;
      classes[node.id] = entry;

      const module = modules[node.parent!]!;
      if (entry.kind === 'provider') module.providers.push(node.id);
      if (entry.kind === 'controller') module.controllers.push(node.id);
      if (entry.exported) module.exports.push(node.id);
    }

    // Enhancer references point at other nodes by id, or name the enhancer directly.
    for (const node of classNodes) {
      const raw = node.metadata.enhancers;
      if (!Array.isArray(raw)) continue;
      classes[node.id]!.enhancers = raw.map((item: Record<string, unknown>): GraphEnhancer => {
        const name =
          typeof item.id === 'string'
            ? (classes[item.id]?.name ?? tokenText(item.id))
            : tokenText(item.name);
        const enhancer: GraphEnhancer = { name, subtype: String(item.subtype) };
        const methodKey = optionalText(item.methodKey);
        if (methodKey !== undefined) enhancer.methodKey = methodKey;
        return enhancer;
      });
    }

    const edges: GraphEdge[] = [];
    for (const raw of Object.values(json?.edges ?? {}) as RawEdge[]) {
      const metadata = raw.metadata;
      if (metadata.type === 'module-to-module') {
        const from = modules[raw.source];
        const to = modules[raw.target];
        if (!from || !to) continue;
        if (!from.imports.includes(to.id)) from.imports.push(to.id);
        edges.push({
          from: from.id,
          to: to.id,
          kind: 'module-to-module',
          internal: from.internal || to.internal,
        });
      } else if (metadata.type === 'class-to-class') {
        const from = classes[raw.source];
        const to = classes[raw.target];
        if (!from || !to) continue;
        const edge: GraphEdge = {
          from: from.id,
          to: to.id,
          kind: 'class-to-class',
          internal: metadata.internal === true || from.internal || to.internal,
        };
        const injection = metadata.injectionType;
        if (injection === 'constructor' || injection === 'property' || injection === 'decorator') {
          edge.injection = injection;
        }
        const key = optionalText(metadata.keyOrIndex);
        if (key !== undefined) edge.key = key;
        edges.push(edge);
      }
    }

    return { modules, classes, edges };
  }
}
