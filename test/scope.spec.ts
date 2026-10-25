import type { GraphModel, GraphModule } from '../src/graph/model.js';
import { describeScope, inScope, resolveScope } from '../src/instance/scope.js';

function module(
  id: string,
  imports: string[] = [],
  internal = false,
  globals: string[] = [],
): GraphModule {
  return {
    id,
    name: id.toUpperCase(),
    global: false,
    dynamic: false,
    internal,
    imports,
    globals,
    exports: [],
    providers: [],
    controllers: [],
  };
}

/** app → cats → owners → (core, internal); cats → inspector; app → other; owners ↔ shared. */
function model(): GraphModel {
  const modules = [
    module('app', ['cats', 'other', 'core']),
    module('cats', ['owners', 'inspector', 'core']),
    module('owners', ['shared', 'core']),
    module('shared', ['owners']),
    module('inspector', ['core']),
    module('other'),
    module('core', [], true),
  ];
  return {
    modules: Object.fromEntries(modules.map((item) => [item.id, item])),
    classes: {},
    edges: [],
  };
}

describe('resolveScope', () => {
  it('is the importer plus its transitive imports, without internals or the instance itself', () => {
    const scope = resolveScope(model(), 'inspector');
    expect(scope).toEqual({
      kind: 'module',
      module: 'CATS',
      modules: new Set(['CATS', 'OWNERS', 'SHARED']),
    });
  });

  it('is unresolved when the instance module is unknown or nothing imports it', () => {
    expect(resolveScope(model(), undefined)).toEqual({ kind: 'unresolved' });
    expect(resolveScope(model(), 'missing')).toEqual({ kind: 'unresolved' });
    expect(resolveScope(model(), 'app')).toEqual({ kind: 'unresolved' });
  });

  it('joins the closures when several modules import the same instance', () => {
    const graph = model();
    graph.modules.other!.imports.push('inspector');
    const scope = resolveScope(graph, 'inspector');
    expect(scope).toEqual({
      kind: 'module',
      module: 'CATS',
      modules: new Set(['CATS', 'OWNERS', 'SHARED', 'OTHER']),
    });
  });

  it('follows implicit links to global modules, but finds importers by declared imports only', () => {
    const graph = model();
    graph.modules.config = module('config', [], false, ['core']);
    graph.modules.cats!.globals.push('config');
    graph.modules.other!.globals.push('inspector');
    expect(resolveScope(graph, 'inspector')).toEqual({
      kind: 'module',
      module: 'CATS',
      modules: new Set(['CATS', 'OWNERS', 'SHARED', 'CONFIG']),
    });
  });
});

describe('inScope', () => {
  it('lets everything through for app and unresolved scopes', () => {
    expect(inScope({ kind: 'app' }, 'ANY')).toBe(true);
    expect(inScope({ kind: 'unresolved' }, 'ANY')).toBe(true);
  });

  it('checks module membership by name for a module scope', () => {
    const scope = resolveScope(model(), 'inspector');
    expect(inScope(scope, 'OWNERS')).toBe(true);
    expect(inScope(scope, 'OTHER')).toBe(false);
    expect(inScope(scope, 'INSPECTOR')).toBe(false);
  });
});

describe('describeScope', () => {
  it('says what an answer is looking at, and why it fell back', () => {
    expect(describeScope({ kind: 'app' })).toEqual({ kind: 'app' });
    expect(describeScope(resolveScope(model(), 'inspector'))).toEqual({
      kind: 'module',
      module: 'CATS',
    });
    expect(describeScope({ kind: 'unresolved' })).toEqual({
      kind: 'module',
      module: null,
      error: 'scope_unresolved',
      fallback: 'app',
    });
  });
});
