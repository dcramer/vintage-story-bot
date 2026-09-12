import { horizontal, key } from './terrain.ts';

// A* over standing cells, in the shape of mineflayer-pathfinder: moves come
// from the terrain grid with their costs, a goal is a predicate, and when the
// goal is beyond what has been seen the best frontier node is returned as a
// partial route to walk before looking again. Planning runs between two
// control frames, so it stops at a deadline and returns what it has.
export function findRoute(
  map,
  start,
  goal,
  _w,
  _h,
  { blocked = new Set(), visits = new Map(), partial = true, budget = 1024, avoid = [], deadlineMs = 250 } = {},
) {
  const deadline = performance.now() + deadlineMs;
  const remaining = p => (goal.horizontalOnly ? horizontal(p, goal) : Math.hypot(p.x - goal.x, (p.y - goal.y) * 0.5, p.z - goal.z));
  const safe = p => avoid.every(item => horizontal(p, item.point) >= item.minimumDistance);
  const reached = p => {
    if (goal.arrivalRadius && horizontal(p, goal) < goal.arrivalRadius && (goal.horizontalOnly || Math.abs(p.y - goal.y) < 0.6)) return true;
    return Math.abs(p.x - goal.x) < 0.51 && Math.abs(p.z - goal.z) < 0.51 && (goal.horizontalOnly || Math.abs(p.y - goal.y) < 0.6);
  };
  // Where the player stands, or the nearest cell it can step onto when it is
  // between cells or on an edge after a jump.
  if (typeof map.nodeAt !== 'function') return null;
  const cx = Math.floor(start.x),
    cz = Math.floor(start.z);
  let origin = map.nodeAt(cx, cz, start.y, 0.6, 0.6);
  if (!origin) {
    const candidates = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        const node = map.nodeAt(cx + dx, cz + dz, start.y, 0.6, 0.6);
        if (node && horizontal(node, start) < 1.3) candidates.push(node);
      }
    origin = candidates.sort((a, b) => horizontal(a, start) - horizontal(b, start))[0] ?? null;
  }
  if (!origin) return null;
  const costs = new Map([[key(origin), 0]]),
    previous = new Map(),
    closed = new Set();
  const open = [{ p: origin, score: remaining(origin) }];
  let frontier = null,
    best = Infinity;
  const path = end => {
    const list = [end];
    while (previous.has(key(end))) {
      end = previous.get(key(end));
      list.push(end);
    }
    list.reverse();
    // The origin cell is where the player already is; keep it only when the
    // body is off the cell and needs to walk onto it first.
    if (list.length > 1 && horizontal(start, list[0]) < 0.35 && Math.abs(start.y - list[0].y) < 0.6) list.shift();
    return list;
  };
  while (open.length && closed.size < budget && performance.now() < deadline) {
    open.sort((a, b) => b.score - a.score);
    const at = open.pop().p,
      id = key(at);
    if (closed.has(id)) continue;
    closed.add(id);
    if (reached(at)) return path(at);
    if (partial && horizontal(start, at) >= 1 && !visits.has(id) && map.frontier(at).size) {
      // A frontier down a hole is not worth walking into: what looks closer
      // to the goal from below may have no way back up. Prefer frontiers at
      // the start's level or above.
      const score = remaining(at) + costs.get(id) * 0.15 + Math.max(0, start.y - at.y - 1) * 3;
      if (score < best) {
        best = score;
        frontier = at;
      }
    }
    const moves = map.moves(at);
    const stepped = new Set(
      moves.map(m => `${Math.sign(Math.floor(m.node.x) - Math.floor(at.x))},${Math.sign(Math.floor(m.node.z) - Math.floor(at.z))}`),
    );
    // Gap jumps are escape edges: only where no ordinary move leaves that way.
    for (const m of map.gapMoves(at)) {
      const dir = `${Math.sign(Math.floor(m.node.x) - Math.floor(at.x))},${Math.sign(Math.floor(m.node.z) - Math.floor(at.z))}`;
      if (!stepped.has(dir)) moves.push(m);
    }
    for (const { node, cost: step } of moves) {
      if (!safe(node) || blocked.has(`${id}>${key(node)}`)) continue;
      const cost = costs.get(id) + step,
        nextId = key(node);
      if ((costs.get(nextId) ?? Infinity) <= cost) continue;
      costs.set(nextId, cost);
      previous.set(nextId, at);
      open.push({ p: node, score: cost + remaining(node) });
    }
  }
  return frontier ? path(frontier) : null;
}
