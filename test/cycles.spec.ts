import { findCycles } from '../src/graph/cycles.js';

describe('findCycles', () => {
  it('finds nothing in a graph without cycles', () => {
    expect(
      findCycles(
        ['a', 'b', 'c'],
        [
          ['a', 'b'],
          ['b', 'c'],
          ['a', 'c'],
        ],
      ),
    ).toEqual([]);
  });

  it('finds each strongly connected component with more than one node', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'];
    const edges: Array<[string, string]> = [
      ['a', 'b'],
      ['b', 'a'],
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'e'],
      ['e', 'c'],
    ];
    expect(findCycles(nodes, edges)).toEqual([
      ['a', 'b'],
      ['c', 'd', 'e'],
    ]);
  });

  it('reports a node with an edge to itself', () => {
    expect(
      findCycles(
        ['a', 'b'],
        [
          ['a', 'a'],
          ['a', 'b'],
        ],
      ),
    ).toEqual([['a']]);
  });

  it('ignores edges to unknown nodes', () => {
    expect(
      findCycles(
        ['a'],
        [
          ['a', 'x'],
          ['x', 'a'],
        ],
      ),
    ).toEqual([]);
  });

  it('handles a long chain without overflowing the stack', () => {
    const nodes = Array.from({ length: 20000 }, (_, index) => `n${index}`);
    const edges = nodes.map((node, index): [string, string] => [
      node,
      nodes[(index + 1) % nodes.length]!,
    ]);
    expect(findCycles(nodes, edges)).toEqual([nodes]);
  });
});
