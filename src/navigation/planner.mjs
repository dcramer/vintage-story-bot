import { distance, horizontal, key } from './terrain.mjs';
const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const jumpDirections = [[2, 0], [-2, 0], [0, 2], [0, -2]];
export function findRoute(map, start, goal, w, h,
  { blocked = new Set(), visits = new Map(), partial = true, budget = 512, avoid = [] } = {}) {
  const remaining = p => goal.horizontalOnly ? horizontal(p, goal) : distance(p, goal);
  const safe = p => avoid.every(item => horizontal(p, item.point) >= item.minimumDistance);
  const centers = [];
  // A reconnect can place the fresh terrain cache around a player who is dry,
  // but already inside the conservative margin of nearby water or fire. Find
  // the nearest fully safe anchor reachable by one continuously validated
  // ground segment; subsequent route cells still cannot enter the margin.
  const escapingMargin = typeof map.dry === 'function' && !map.dry(start, w, h);
  const anchorRadius = escapingMargin ? 6 : 1;
  for (let x = -anchorRadius; x <= anchorRadius; x++) for (let z = -anchorRadius; z <= anchorRadius; z++) {
    const p = map.stand(Math.floor(start.x) + .5 + x, Math.floor(start.z) + .5 + z, start.y, w, h, escapingMargin);
    if (p && (!escapingMargin || horizontal(p, start) >= .75)) centers.push(p);
  }
  const anchor = centers.sort((a, b) => distance(a, start) - distance(b, start))
    .find(p => map.traverse(start, p, w, h, true, undefined, escapingMargin));
  if (!anchor) return null;
  const recentering = map.support(start, w) !== 9 && distance(anchor, start) >= .12;
  const center = recentering ? { ...anchor, recenter: true } : anchor;
  // Move one verified step farther from the hazard, then resample from the new
  // position. The native sensor's six-block radius bounds this recovery and a
  // later plan can continue until the ordinary dry graph is reachable.
  if (escapingMargin && !map.dry(center, w, h)) return [center];
  const costs = new Map([[key(center), 0]]), previous = new Map(), closed = new Set(), open = [{ p: center, score: 0 }];
  let frontier, best = Infinity;
  const path = end => {
    const list = [end];
    while (previous.has(key(end))) { end = previous.get(key(end)); list.push(end); }
    list.reverse();
    // The grid center is a planning anchor, not a mandatory physical waypoint.
    // Slow samples can leave the player well off-center while still safely
    // connected to the first real step.
    if (!recentering && list.length > 1 && (list[1].jumpGap
      ? map.jumpTraverse?.(start, list[1], w, h)
      : map.traverse(start, list[1], w, h, true))) list.shift();
    return list;
  };
  while (open.length && closed.size < budget) {
    open.sort((a, b) => b.score - a.score);
    const at = open.pop().p, id = key(at);
    if (closed.has(id)) continue;
    closed.add(id);
    if (goal.arrivalRadius && horizontal(at, goal) < goal.arrivalRadius && (goal.horizontalOnly || Math.abs(at.y - goal.y) < .1)) return path(at);
    const destination = { ...goal, y: goal.horizontalOnly ? at.y : goal.y };
    if (Math.abs(at.x - goal.x) < .51 && Math.abs(at.z - goal.z) < .51 && Math.abs(at.y - destination.y) < .15 &&
        safe(destination) && map.traverse(at, destination, w, h)) {
      const list = path(at); if (distance(at, destination) > .001) list.push(destination); return list;
    }
    if (partial && distance(start, at) >= 1 && !visits.has(id) && map.frontier(at, w, h).size) {
      const score = remaining(at) + costs.get(id) * .15;
      if (score < best) { best = score; frontier = at; }
    }
    for (const [dx, dz] of directions) {
      const next = map.stand(at.x + dx, at.z + dz, at.y, w, h);
      if (!next || !safe(next) || blocked.has(`${id}>${key(next)}`) || !map.traverse(at, next, w, h)) continue;
      const cost = costs.get(id) + 1 + Math.abs(next.y - at.y), nextId = key(next);
      if ((costs.get(nextId) ?? Infinity) <= cost) continue;
      costs.set(nextId, cost); previous.set(nextId, at); open.push({ p: next, score: cost + remaining(next) });
    }
    // A single observed hole or gap must not strand the bot on a terrain
    // island. Gap edges carry an explicit marker so execution jumps only the
    // exact segment whose landing and arc were validated by TerrainMemory.
    if (typeof map.jumpTraverse === 'function') for (const [dx, dz] of jumpDirections) {
      const landing = map.stand(at.x + dx, at.z + dz, at.y, w, h);
      if (!landing || !safe(landing) || !map.jumpTraverse(at, landing, w, h)) continue;
      // Prefer a same-length supported detour; jumping is an escape edge, not
      // a shortcut across ordinary walkable terrain.
      const next = { ...landing, jumpGap: true }, cost = costs.get(id) + 5 + Math.abs(next.y - at.y);
      const nextId = key(next);
      if ((costs.get(nextId) ?? Infinity) <= cost) continue;
      costs.set(nextId, cost); previous.set(nextId, at); open.push({ p: next, score: cost + remaining(next) });
    }
  }
  // A natively grounded player can rest on a thin edge with partial sampled
  // support. The nearest safe center may be less than the ordinary one-block
  // frontier threshold; move there first, then resample from full support.
  return frontier ? path(frontier) : recentering ? [center] : null;
}
