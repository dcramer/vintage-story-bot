import { key } from './terrain.ts';

// Reaching a viewpoint is evidence across legs. Reconsider it when the view
// reveals one of its missing cells, or after a minute, not on every new leg.
const memories = new WeakMap<object, Map<string, { until: number; missing: { x: number; y: number; z: number }[] }>>();

export function visitedFrontiers(map, now = Date.now()) {
  const memory = memories.get(map);
  const visits = new Map<string, number>();
  if (!memory) return visits;
  for (const [id, visit] of memory) {
    if (visit.until <= now || visit.missing.some(p => map.get(p.x, p.y, p.z))) memory.delete(id);
    else visits.set(id, 1);
  }
  return visits;
}

export function visitFrontier(map, point, now: number) {
  let memory = memories.get(map);
  if (!memory) memories.set(map, (memory = new Map()));
  const id = key(point);
  memory.delete(id);
  memory.set(id, { until: now + 60000, missing: [...map.frontier(point).values()] });
  while (memory.size > 256) memory.delete(memory.keys().next().value!);
}
