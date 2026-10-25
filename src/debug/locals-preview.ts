/**
 * What the locals worker turns a paused frame into: the values of its variables as a bounded,
 * JSON-ready preview. Pure: it reads through the `inspect` function it is given (the worker's
 * inspector session) and only ever calls `Runtime.getProperties`, which never runs the app's code
 * (ADR-0005).
 */

/** A variable's value as `locals` shows it. Non-JSON values are bracketed strings (`[undefined]`). */
export type LocalValue = null | boolean | number | string | LocalValue[] | LocalObject;

export interface LocalObject {
  [key: string]: LocalValue;
}

/** The scopes of one frame: `local` (block and `catch` scopes merged in) and `closure`. */
export interface LocalScopes {
  local: LocalObject;
  closure: LocalObject;
}

/** One frame as the worker captured it, with the position V8 ran (not yet source-mapped). */
export interface CapturedFrame {
  function: string;
  /** An absolute path, or the URL V8 gives (`file://` already turned into a path). */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  /** Not the app's code: its scopes are not read. */
  external?: true;
  scopes?: LocalScopes;
}

export interface LocalsBounds {
  /** Top frames whose scopes are read. */
  frames: number;
  /** Levels of objects expanded below a variable. */
  depth: number;
  /** Properties per object, items per array and variables per scope. */
  properties: number;
  /** Characters kept per string. */
  stringLength: number;
  /** Bytes of JSON per error, all frames together. */
  bytes: number;
}

/** What the inspector protocol gives the worker. Only the fields read here. */
export interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

export interface PropertyDescriptor {
  name: string;
  value?: RemoteObject;
  get?: RemoteObject;
  set?: RemoteObject;
  enumerable?: boolean;
  isOwn?: boolean;
  symbol?: RemoteObject;
}

export interface CallFrame {
  functionName: string;
  location: { scriptId: string; lineNumber: number; columnNumber?: number };
  scopeChain: Array<{ type: string; object: RemoteObject }>;
}

/** `Runtime.getProperties` of the session, own properties only. */
export type GetProperties = (objectId: string) => Promise<PropertyDescriptor[]>;

/** Scopes read into `local`; `closure` scopes go to `closure`; the rest is never read. */
const LOCAL_SCOPES = new Set(['local', 'block', 'catch']);

const SCOPES_WRAPPER = ',"scopes":{"local":{},"closure":{}}';

/** Shown in place of what the byte budget no longer allows. */
export const TRUNCATED = '[…]';

/** Spends the byte budget of one error; once it runs out, nothing more is read. */
class Budget {
  private remaining: number;

  constructor(
    bytes: number,
    private readonly deadline: number,
  ) {
    this.remaining = bytes;
  }

  get exhausted(): boolean {
    return this.remaining <= 0 || Date.now() > this.deadline;
  }

  /**
   * Spends what `key: value` adds to the JSON (an object or array only its brackets: its contents
   * were spent as they were read); false, and the budget closed, when it does not fit.
   */
  take(key: string | undefined, value: LocalValue): boolean {
    const own = typeof value === 'object' && value !== null ? 2 : jsonBytes(value);
    const cost = (key === undefined ? 0 : jsonBytes(key) + 1) + own + 1;
    if (cost > this.remaining) {
      this.remaining = 0;
      return false;
    }
    this.remaining -= cost;
    return true;
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** `s` cut to `max` characters, saying how long it was. */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…[${s.length} chars]`;
}

function firstLine(text: string | undefined): string {
  const line = (text ?? '').split('\n', 1)[0] ?? '';
  return line.trim();
}

/** A function by its name, never its source (which V8 gives as the description). */
function functionLabel(description: string | undefined): string {
  const text = description ?? '';
  const declared = /^(?:async\s+)?(?:function\s*\*?\s*|class\s+)([\w$]+)/.exec(text);
  if (/^class\b/.test(text)) return declared ? `[class ${declared[1]}]` : '[class]';
  return declared ? `[Function: ${declared[1]}]` : '[Function]';
}

/** The value of a primitive or of an object without entering it. */
function leaf(object: RemoteObject, bounds: LocalsBounds): LocalValue | undefined {
  switch (object.type) {
    case 'undefined':
      return '[undefined]';
    case 'boolean':
      return object.value as boolean;
    case 'number':
      return object.unserializableValue !== undefined
        ? `[${object.unserializableValue}]`
        : (object.value as number);
    case 'bigint':
      return `[${object.unserializableValue ?? object.description ?? 'bigint'}]`;
    case 'string':
      return truncate(String(object.value ?? ''), bounds.stringLength);
    case 'symbol':
      return `[${truncate(object.description ?? 'Symbol()', bounds.stringLength)}]`;
    case 'function':
      return functionLabel(object.description);
    default:
      break;
  }
  if (object.subtype === 'null') return null;
  if (object.subtype !== undefined && object.subtype !== 'array') {
    // Map(2), Set(1), a date, /re/g, Promise, Proxy, Uint8Array(4), Error: message…
    return `[${truncate(firstLine(object.description) || object.subtype, bounds.stringLength)}]`;
  }
  return undefined;
}

/** What an object is called when it is not entered: `[Array(3)]`, `[Object]`, `[Cat]`. */
function collapsed(object: RemoteObject, bounds: LocalsBounds): string {
  const name =
    object.subtype === 'array' ? firstLine(object.description) : (object.className ?? 'Object');
  return `[${truncate(name || 'Object', bounds.stringLength)}]`;
}

class Previewer {
  constructor(
    private readonly getProperties: GetProperties,
    private readonly bounds: LocalsBounds,
    readonly budget: Budget,
  ) {}

  /** `object` at `level` (0 for a variable): primitives as they are, objects `depth` levels deep. */
  async value(object: RemoteObject, level: number): Promise<LocalValue> {
    const simple = leaf(object, this.bounds);
    if (simple !== undefined) return simple;
    if (level >= this.bounds.depth || object.objectId === undefined || this.budget.exhausted) {
      return collapsed(object, this.bounds);
    }
    const properties = await this.getProperties(object.objectId);
    return object.subtype === 'array'
      ? this.items(properties, object, level)
      : this.fields(properties, object, level);
  }

  private async items(
    properties: PropertyDescriptor[],
    object: RemoteObject,
    level: number,
  ): Promise<LocalValue[]> {
    const indexed = own(properties).filter((property) => /^\d+$/.test(property.name));
    const length = Number(/\((\d+)\)/.exec(object.description ?? '')?.[1] ?? indexed.length);
    const items: LocalValue[] = [];
    for (const property of indexed.slice(0, this.bounds.properties)) {
      const item = await this.property(property, level);
      if (!this.budget.take(undefined, item)) {
        items.push(TRUNCATED);
        return items;
      }
      items.push(item);
    }
    if (length > items.length) items.push(`[… ${length - items.length} more]`);
    return items;
  }

  private async fields(
    properties: PropertyDescriptor[],
    object: RemoteObject,
    level: number,
  ): Promise<LocalObject> {
    const result: LocalObject = {};
    const className = object.className ?? 'Object';
    if (className !== 'Object') result['[[Class]]'] = className;
    await this.fill(result, own(properties), level);
    return result;
  }

  /** Copies `properties` into `target` while the bounds allow. */
  async fill(target: LocalObject, properties: PropertyDescriptor[], level: number): Promise<void> {
    const kept = properties.slice(0, this.bounds.properties);
    for (const property of kept) {
      if (property.name in target) continue;
      const value = await this.property(property, level);
      if (!this.budget.take(property.name, value)) {
        target['…'] = TRUNCATED;
        return;
      }
      target[property.name] = value;
    }
    if (properties.length > kept.length) {
      target['…'] = `[${properties.length - kept.length} more]`;
    }
  }

  /** An accessor is named, never called; anything else is previewed one level down. */
  private async property(property: PropertyDescriptor, level: number): Promise<LocalValue> {
    if (property.value === undefined) {
      // V8 gives a missing half of an accessor as an `undefined` object.
      const get = property.get !== undefined && property.get.type !== 'undefined';
      const set = property.set !== undefined && property.set.type !== 'undefined';
      if (get && set) return '[Getter/Setter]';
      return get ? '[Getter]' : set ? '[Setter]' : '[undefined]';
    }
    return this.value(property.value, level + 1);
  }
}

/** Own, enumerable, string-keyed properties: what `Object.keys` would list, without `__proto__`. */
function own(properties: PropertyDescriptor[]): PropertyDescriptor[] {
  return properties.filter(
    (property) =>
      property.isOwn !== false &&
      property.enumerable !== false &&
      property.symbol === undefined &&
      property.name !== '__proto__',
  );
}

/** Variables of a scope, as the inspector lists them; V8's internal ones (`.foo`) left out. */
function variables(properties: PropertyDescriptor[]): PropertyDescriptor[] {
  return properties.filter((property) => !property.name.startsWith('.'));
}

export interface CaptureInput {
  callFrames: CallFrame[];
  /** The file of a script, by its id; `undefined` when V8 gave none. */
  fileOf(scriptId: string): string | undefined;
  /** Whether a file is the app's own code (its scopes are read). */
  isApp(file: string | undefined): boolean;
  getProperties: GetProperties;
  bounds: LocalsBounds;
  /** Milliseconds the whole capture may take; past it, nothing more is read. */
  timeoutMs: number;
}

export interface Capture {
  frames: CapturedFrame[];
  /** The byte budget or the time limit ran out before everything was read. */
  truncated?: true;
}

/** Reads the scopes of the top frames of a pause, within the bounds. */
export async function captureFrames(input: CaptureInput): Promise<Capture> {
  const budget = new Budget(input.bounds.bytes, Date.now() + input.timeoutMs);
  const previewer = new Previewer(input.getProperties, input.bounds, budget);
  const frames: CapturedFrame[] = [];
  let truncated = false;
  for (const callFrame of input.callFrames.slice(0, input.bounds.frames)) {
    const file = input.fileOf(callFrame.location.scriptId);
    const frame: CapturedFrame = {
      function: callFrame.functionName || '<anonymous>',
      file: file ?? '<anonymous>',
      line: callFrame.location.lineNumber + 1,
      column: (callFrame.location.columnNumber ?? 0) + 1,
    };
    // The header, and the `scopes` wrapper it may get.
    if (!budget.take(undefined, `${JSON.stringify(frame)}${SCOPES_WRAPPER}`)) {
      truncated = true;
      break;
    }
    frames.push(frame);
    if (!input.isApp(file)) {
      frame.external = true;
      continue;
    }
    const scopes: LocalScopes = { local: {}, closure: {} };
    frame.scopes = scopes;
    for (const scope of callFrame.scopeChain) {
      if (budget.exhausted) break;
      const target = LOCAL_SCOPES.has(scope.type)
        ? scopes.local
        : scope.type === 'closure'
          ? scopes.closure
          : undefined;
      if (!target || scope.object.objectId === undefined) continue;
      const properties = variables(await input.getProperties(scope.object.objectId));
      await previewer.fill(target, properties, -1);
    }
    if (budget.exhausted) {
      truncated = true;
      break;
    }
  }
  // A safety net: the budget's accounting is meant to keep this from ever dropping a frame.
  while (frames.length > 0 && Buffer.byteLength(JSON.stringify(frames)) > input.bounds.bytes) {
    frames.pop();
    truncated = true;
  }
  return truncated ? { frames, truncated: true } : { frames };
}

/**
 * Whether the frame that threw is rethrowing, from a `catch` block, the very exception it caught:
 * a `catch` scope holds an error with the same stack text.
 */
export async function isRethrow(
  callFrame: CallFrame,
  key: string,
  getProperties: GetProperties,
): Promise<boolean> {
  for (const scope of callFrame.scopeChain) {
    if (scope.type !== 'catch' || scope.object.objectId === undefined) continue;
    const properties = await getProperties(scope.object.objectId);
    if (properties.some((p) => p.value?.subtype === 'error' && p.value.description === key)) {
      return true;
    }
  }
  return false;
}
