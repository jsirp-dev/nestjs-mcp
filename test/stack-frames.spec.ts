import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SourceMaps, stackFrames } from '../src/debug/stack-frames.js';

/** A source map whose only mapping sends the generated (0, 4) to the original (2, 6) of `source`. */
function payload(source: string, extra: Record<string, unknown> = {}) {
  // `AAAA` = [0,0,0,0]; `IAEM` = [+4 col, src +0, line +2, col +6].
  return { version: 3, sources: [source], names: [], mappings: 'AAAA,IAEM', ...extra };
}

describe('stack frames', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nest-mcp-frames-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const noMaps = () => new SourceMaps();

  it('parses the frame forms V8 writes', () => {
    const stack = [
      'Error: boom',
      '    with a second message line',
      '    at CatsController.find (/app/dist/cats.controller.js:12:11)',
      '    at /app/dist/main.js:3:7',
      '    at async Promise.all (index 0)',
      '    at new Thing (/app/dist/thing.js:1:2)',
      '    at Array.map (<anonymous>)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
      '    at Object.handle (/app/node_modules/@nestjs/core/router.js:40:9)',
      `    at load (${pathToFileURL('/app/dist/esm.mjs').href}:4:2)`,
    ].join('\n');

    expect(stackFrames(stack, 30, noMaps())).toEqual([
      {
        function: 'CatsController.find',
        file: '/app/dist/cats.controller.js',
        line: 12,
        column: 11,
        mapped: false,
      },
      { function: '<anonymous>', file: '/app/dist/main.js', line: 3, column: 7, mapped: false },
      { function: 'async Promise.all', file: 'index 0', mapped: false, external: true },
      { function: 'new Thing', file: '/app/dist/thing.js', line: 1, column: 2, mapped: false },
      { function: 'Array.map', file: '<anonymous>', mapped: false, external: true },
      {
        function: 'process.processTicksAndRejections',
        file: 'node:internal/process/task_queues',
        line: 95,
        column: 5,
        mapped: false,
        external: true,
      },
      {
        function: 'Object.handle',
        file: '/app/node_modules/@nestjs/core/router.js',
        line: 40,
        column: 9,
        mapped: false,
        external: true,
      },
      { function: 'load', file: '/app/dist/esm.mjs', line: 4, column: 2, mapped: false },
    ]);
  });

  it('keeps at most `limit` frames', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `    at f${i} (/app/a.js:${i + 1}:1)`);
    const frames = stackFrames(['Error: deep', ...lines].join('\n'), 30, noMaps());
    expect(frames).toHaveLength(30);
    expect(frames[29]!.function).toBe('f29');
  });

  it('takes a position that is not JavaScript as already mapped', () => {
    const frames = stackFrames('Error: x\n    at f (/app/src/cats.ts:7:3)', 30, noMaps());
    expect(frames).toEqual([
      { function: 'f', file: '/app/src/cats.ts', line: 7, column: 3, mapped: true },
    ]);
  });

  it('answers nothing for text without frames, and never throws', () => {
    expect(stackFrames('', 30, noMaps())).toEqual([]);
    expect(stackFrames('just a message', 30, noMaps())).toEqual([]);
    expect(() => stackFrames('Error\n    at (:::)\n    at x (y:z)', 30, noMaps())).not.toThrow();
  });

  it("maps a frame through the compiled file's own map, next to it", () => {
    const compiled = join(dir, 'dist', 'cats.js');
    const original = join(dir, 'src', 'cats.ts');
    mkdirSync(join(dir, 'dist'));
    writeFileSync(compiled, 'code;\n//# sourceMappingURL=cats.js.map\n');
    writeFileSync(`${compiled}.map`, JSON.stringify(payload('../src/cats.ts')));

    const maps = new SourceMaps();
    const [frame] = stackFrames(`Error: x\n    at find (${compiled}:1:5)`, 30, maps);
    expect(frame).toEqual({ function: 'find', file: original, line: 3, column: 7, mapped: true });
    expect(maps.found).toBe(1);
  });

  it('maps through an inline map and resolves sourceRoot', () => {
    const compiled = join(dir, 'inline.js');
    const map = payload('cats.ts', { sourceRoot: 'src/' });
    const data = Buffer.from(JSON.stringify(map)).toString('base64');
    writeFileSync(
      compiled,
      `code;\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${data}\n`,
    );
    const [frame] = stackFrames(`Error: x\n    at f (${compiled}:1:5)`, 30, new SourceMaps());
    expect(frame).toMatchObject({ file: join(dir, 'src', 'cats.ts'), line: 3, mapped: true });
  });

  it('keeps a source with another URL scheme as written', () => {
    const compiled = join(dir, 'bundle.js');
    writeFileSync(compiled, 'code;\n//# sourceMappingURL=bundle.js.map\n');
    writeFileSync(`${compiled}.map`, JSON.stringify(payload('webpack://app/./src/main.ts')));
    const [frame] = stackFrames(`Error: x\n    at f (${compiled}:1:5)`, 30, new SourceMaps());
    expect(frame).toMatchObject({ file: 'webpack://app/./src/main.ts', line: 3, mapped: true });
  });

  it('keeps the compiled position, unmapped, when there is no map or it is unreadable', () => {
    const plain = join(dir, 'plain.js');
    writeFileSync(plain, 'code;\n');
    const broken = join(dir, 'broken.js');
    writeFileSync(broken, 'code;\n//# sourceMappingURL=broken.js.map\n');
    writeFileSync(`${broken}.map`, '{ not json');
    const gone = join(dir, 'gone.js');

    const maps = new SourceMaps();
    const frames = stackFrames(
      [
        `Error: x`,
        `    at a (${plain}:1:5)`,
        `    at b (${broken}:1:5)`,
        `    at c (${gone}:1:5)`,
      ].join('\n'),
      30,
      maps,
    );
    expect(frames.map((frame) => [frame.file, frame.line, frame.mapped])).toEqual([
      [plain, 1, false],
      [broken, 1, false],
      [gone, 1, false],
    ]);
    expect(maps.found).toBe(0);
  });

  it('reads each file once and keeps no source text', () => {
    const compiled = join(dir, 'once.js');
    writeFileSync(compiled, 'code;\n//# sourceMappingURL=once.js.map\n');
    writeFileSync(
      `${compiled}.map`,
      JSON.stringify(payload('once.ts', { sourcesContent: ['const secret = 1;'] })),
    );
    const maps = new SourceMaps();
    stackFrames(`Error: x\n    at f (${compiled}:1:5)`, 30, maps);
    rmSync(`${compiled}.map`);
    const [again] = stackFrames(`Error: x\n    at f (${compiled}:1:5)`, 30, maps);
    expect(again!.mapped).toBe(true);
    expect(JSON.stringify(maps.lookup(compiled)?.payload)).not.toContain('secret');
  });

  it('does not map external frames', () => {
    const compiled = join(dir, 'node_modules', 'lib', 'index.js');
    mkdirSync(join(dir, 'node_modules', 'lib'), { recursive: true });
    writeFileSync(compiled, 'code;\n//# sourceMappingURL=index.js.map\n');
    writeFileSync(`${compiled}.map`, JSON.stringify(payload('index.ts')));
    const [frame] = stackFrames(`Error: x\n    at f (${compiled}:1:5)`, 30, new SourceMaps());
    expect(frame).toMatchObject({ file: compiled, line: 1, mapped: false, external: true });
  });
});
