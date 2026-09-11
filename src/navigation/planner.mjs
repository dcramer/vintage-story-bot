import { distance, key } from './terrain.mjs';
const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
export function findRoute(map, start, goal, w, h, { blocked = new Set(), visits = new Map(), partial = true, budget = 512 } = {}) {
  const centers = [];
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
    const p = map.stand(Math.floor(start.x) + .5 + x, Math.floor(start.z) + .5 + z, start.y, w, h);
    if (p) centers.push(p);
  }
  const center = centers.sort((a, b) => distance(a, start) - distance(b, start)).find(p => map.traverse(start, p, w, h, true));
  if (!center) return null;
  const costs = new Map([[key(center), 0]]), previous = new Map(), closed = new Set(), open = [{ p: center, score: 0 }];
  let frontier, best = Infinity;
  const path = end => { const list = [end]; while (previous.has(key(end))) { end = previous.get(key(end)); list.push(end); } return list.reverse(); };
  while (open.length && closed.size < budget) {
    open.sort((a, b) => b.score - a.score);
    const at = open.pop().p, id = key(at);
    if (closed.has(id)) continue;
    closed.add(id);
    if (Math.abs(at.x - goal.x) < .51 && Math.abs(at.z - goal.z) < .51 && Math.abs(at.y - goal.y) < .15 && map.traverse(at, goal, w, h)) {
      const list = path(at); if (distance(at, goal) > .001) list.push(goal); return list;
    }
    if (partial && distance(start, at) >= 1 && !visits.has(id) && map.frontier(at, w, h).size) {
      const score = distance(at, goal) + costs.get(id) * .15;
      if (score < best) { best = score; frontier = at; }
    }
    for (const [dx, dz] of directions) {
      if (Math.abs(at.x + dx - start.x) > 32 || Math.abs(at.z + dz - start.z) > 32) continue;
      const next = map.stand(at.x + dx, at.z + dz, at.y, w, h);
      if (!next || blocked.has(`${id}>${key(next)}`) || !map.traverse(at, next, w, h)) continue;
      const cost = costs.get(id) + 1 + Math.abs(next.y - at.y), nextId = key(next);
      if ((costs.get(nextId) ?? Infinity) <= cost) continue;
      costs.set(nextId, cost); previous.set(nextId, at); open.push({ p: next, score: cost + distance(next, goal) });
    }
  }
  return frontier ? path(frontier) : null;
}
