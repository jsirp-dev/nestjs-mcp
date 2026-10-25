/**
 * The cycles of a directed graph: Tarjan's strongly connected components with more than one
 * node, plus nodes with an edge to themselves. Iterative, so a deep graph cannot overflow the
 * stack. Components come out in discovery order, each in the order its members were visited.
 */
export function findCycles(
  nodes: readonly string[],
  edges: ReadonlyArray<[string, string]>,
): string[][] {
  const next = new Map<string, string[]>(nodes.map((node) => [node, []]));
  const selfLoops = new Set<string>();
  for (const [from, to] of edges) {
    if (!next.has(from) || !next.has(to)) continue;
    if (from === to) selfLoops.add(from);
    next.get(from)!.push(to);
  }

  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: Array<{ order: number; members: string[] }> = [];
  let counter = 0;

  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; child: number }> = [{ node: root, child: 0 }];
    index.set(root, counter);
    lowLink.set(root, counter++);
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const children = next.get(frame.node)!;
      if (frame.child < children.length) {
        const child = children[frame.child++]!;
        if (!index.has(child)) {
          index.set(child, counter);
          lowLink.set(child, counter++);
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, child: 0 });
        } else if (onStack.has(child)) {
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node)!, index.get(child)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        lowLink.set(parent.node, Math.min(lowLink.get(parent.node)!, lowLink.get(frame.node)!));
      }
      if (lowLink.get(frame.node) !== index.get(frame.node)) continue;
      const members: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        members.unshift(member);
      } while (member !== frame.node);
      if (members.length > 1 || selfLoops.has(frame.node)) {
        found.push({ order: index.get(frame.node)!, members });
      }
    }
  }

  return found.sort((a, b) => a.order - b.order).map((cycle) => cycle.members);
}
