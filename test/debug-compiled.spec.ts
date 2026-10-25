import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import ts from 'typescript';
import { freePort, toolJson } from './support/start-app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool answers are walked freely
type Json = Record<string, any>;

const ROOT = join(__dirname, '..');
const FIXTURE = join(__dirname, 'fixtures', 'compiled', 'app.ts');
const THROW = "throw new Error('compiled failure')";

/** The 1-based line of `text` in `code`. */
function lineOf(code: string, text: string): number {
  return code.split('\n').findIndex((line) => line.includes(text)) + 1;
}

/**
 * Compiles the fixture to `<dir>/app.js` as `tsc` would (CommonJS, decorators), with its
 * `.js.map` next to it when `sourceMap`, whose source is the fixture itself. `@jsirp/nestjs-mcp`
 * resolves to this package's build through a link; everything else through `NODE_PATH`.
 */
function compile(dir: string, sourceMap: boolean): string {
  const output = ts.transpileModule(readFileSync(FIXTURE, 'utf8'), {
    fileName: 'app.ts',
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
      sourceMap,
    },
  });
  const compiled = join(dir, 'app.js');
  writeFileSync(compiled, output.outputText);
  if (sourceMap) {
    const map = JSON.parse(output.sourceMapText!);
    map.sources = [relative(dir, FIXTURE)];
    writeFileSync(`${compiled}.map`, JSON.stringify(map));
  }
  mkdirSync(join(dir, 'node_modules', '@jsirp'), { recursive: true });
  symlinkSync(ROOT, join(dir, 'node_modules', '@jsirp', 'nestjs-mcp'), 'dir');
  return compiled;
}

interface Child {
  process: ChildProcess;
  appPort: number;
  client: Client;
}

async function run(compiled: string, flags: string[] = []): Promise<Child> {
  const appPort = await freePort();
  const inspectorPort = await freePort();
  const child = spawn(process.execPath, [...flags, compiled], {
    env: {
      ...process.env,
      NODE_PATH: join(ROOT, 'node_modules'),
      NODE_OPTIONS: '',
      APP_PORT: String(appPort),
      INSPECTOR_PORT: String(inspectorPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ready line: ${output}`)), 15_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('ready\n')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout!.on('data', read);
    child.stderr!.on('data', read);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`exited with ${code}: ${output}`));
    });
  });
  const client = new Client({ name: 'debug-compiled-spec', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${inspectorPort}/`)),
  );
  return { process: child, appPort, client };
}

describe('debug option on compiled code', () => {
  let dir: string;
  let child: Child | undefined;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'nest-mcp-compiled-')));
  });

  afterEach(async () => {
    await child?.client.close();
    if (child && child.process.exitCode === null) {
      const exited = new Promise((resolve) => child!.process.once('exit', resolve));
      child.process.kill();
      await exited;
    }
    child = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function failingFrame(): Promise<Json> {
    const id = `compiled-${Date.now()}`;
    const response = await fetch(`http://127.0.0.1:${child!.appPort}/boom`, {
      headers: { 'x-nest-mcp-request-id': id },
    });
    expect(response.status).toBe(500);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      toolJson(await child!.client.callTool({ name, arguments: args })) as Json;
    const { trace } = await call('request_trace', { id });
    const step = trace.steps.find((candidate: Json) => candidate.kind === 'handler');
    expect(step.outcome).toBe('threw');
    return { frame: step.error.stack[0], info: await call('app_info') };
  }

  it("maps the throw to the .ts line through the build's own .js.map", async () => {
    child = await run(compile(dir, true));
    const { frame, info } = await failingFrame();
    expect(frame).toEqual({
      function: 'BoomController.boom',
      file: FIXTURE,
      line: lineOf(readFileSync(FIXTURE, 'utf8'), THROW),
      column: expect.any(Number),
      mapped: true,
    });
    expect(info.debug.sourceMaps).toEqual({ process: false, files: 1 });
  }, 30_000);

  it('keeps the compiled position, unmapped, without a source map', async () => {
    const compiled = compile(dir, false);
    child = await run(compiled);
    const { frame, info } = await failingFrame();
    expect(frame).toEqual({
      function: 'BoomController.boom',
      file: compiled,
      line: lineOf(readFileSync(compiled, 'utf8'), THROW),
      column: expect.any(Number),
      mapped: false,
    });
    expect(info.debug.sourceMaps).toEqual({ process: false, files: 0 });
  }, 30_000);

  it('reads the position Node already mapped with --enable-source-maps', async () => {
    child = await run(compile(dir, true), ['--enable-source-maps']);
    const { frame, info } = await failingFrame();
    expect(frame).toMatchObject({
      file: FIXTURE,
      line: lineOf(readFileSync(FIXTURE, 'utf8'), THROW),
      mapped: true,
    });
    expect(info.debug.sourceMaps.process).toBe(true);
  }, 30_000);
});
