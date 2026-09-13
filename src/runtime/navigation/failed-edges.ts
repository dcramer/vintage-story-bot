// Failed inputs are route evidence shared across short legs, never world facts.
// Expire it so a changed obstacle can be tried again; keep each bot's map isolated.
const memories = new WeakMap<object, Map<string, number>>();
const KEEP_MS = 60000;

export function failedEdges(map: object, now = Date.now()): Set<string> {
  const memory = memories.get(map);
  if (!memory) return new Set();
  for (const [edge, until] of memory) if (until <= now) memory.delete(edge);
  return new Set(memory.keys());
}

export function failEdge(map: object, edge: string, now: number) {
  let memory = memories.get(map);
  if (!memory) memories.set(map, (memory = new Map()));
  memory.delete(edge);
  memory.set(edge, now + KEEP_MS);
  while (memory.size > 256) memory.delete(memory.keys().next().value!);
}
