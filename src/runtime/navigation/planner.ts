import { horizontal, JUMP_HEIGHT, key } from './terrain.ts';

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
  { blocked = new Set(), visits = new Map(), partial = true, budget = 1024, avoid = [], deadlineMs = 600 } = {},
) {
  const deadline = performance.now() + deadlineMs;
  const remaining = p => (goal.horizontalOnly ? horizontal(p, goal) : Math.hypot(p.x - goal.x, (p.y - goal.y) * 0.5, p.z - goal.z));
  // A hostile is kept clear of, not by refusing every cell nearer than the body is now (a notch in a hill
  // would trap the bot), but by charging for closeness: cells inside the kept distance cost extra by how
  // far inside they are, and only cells within striking range are refused outright.
  const safe = p => avoid.every(item => horizontal(p, item.point) >= Math.min(3, item.minimumDistance));
  const dread = p => avoid.reduce((sum, item) => sum + Math.max(0, item.minimumDistance - horizontal(p, item.point)) * 4, 0);
  const reached = p => {
    if (goal.arrivalRadius && horizontal(p, goal) < goal.arrivalRadius && (goal.horizontalOnly || Math.abs(p.y - goal.y) < 0.6)) return true;
    return Math.abs(p.x - goal.x) < 0.51 && Math.abs(p.z - goal.z) < 0.51 && (goal.horizontalOnly || Math.abs(p.y - goal.y) < 0.6);
  };
  // Where the player stands, or the nearest cell it can step onto when it is
  // between cells or on an edge after a jump.
  if (typeof map.nodeAt !== 'function') return null;
  const cx = Math.floor(start.x),
    cz = Math.floor(start.z);
  // A body in water may have sunk well under its swim node: look further up for it.
  const up = start.afloat ? 3 : 0.6;
  let origin = map.nodeAt(cx, cz, start.y, up, 0.6);
  if (!origin) {
    const candidates = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        const node = map.nodeAt(cx + dx, cz + dz, start.y, up, 0.6);
        if (node && horizontal(node, start) < 1.3) candidates.push(node);
      }
    origin = candidates.sort((a, b) => horizontal(a, start) - horizontal(b, start))[0] ?? null;
  }
  if (!origin) return null;
  const costs = new Map([[key(origin), 0]]),
    previous = new Map(),
    closed = new Set(),
    // Cells reached only through a drop the body could not climb back. A full route may take
    // one; a partial route never ends beyond one, or the walk commits to a hole for a frontier
    // that merely looked nearer to the goal from below.
    committed = new Set(),
    floorY = Math.min(start.y, Number.isFinite(goal.y) ? goal.y : start.y);
  const open = new Heap();
  open.push({ p: origin, score: remaining(origin) });
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
  while (open.size && closed.size < budget && performance.now() < deadline) {
    const at = open.pop().p,
      id = key(at);
    if (closed.has(id)) continue;
    closed.add(id);
    if (reached(at)) return path(at);
    // One expansion per node: the unknown cells it borders (its frontier) fall out of the same pass.
    const missing = new Map();
    const moves = map.moves(at, missing);
    const stepped = new Set(
      moves.map(m => `${Math.sign(Math.floor(m.node.x) - Math.floor(at.x))},${Math.sign(Math.floor(m.node.z) - Math.floor(at.z))}`),
    );
    // Gap jumps are escape edges: only where no ordinary move leaves that way.
    for (const m of map.gapMoves(at, missing)) {
      const dir = `${Math.sign(Math.floor(m.node.x) - Math.floor(at.x))},${Math.sign(Math.floor(m.node.z) - Math.floor(at.z))}`;
      if (!stepped.has(dir)) moves.push(m);
    }
    // A frontier in deep water is not progress: the far bank is what counts, and only a full route reaches it.
    const hole = committed.has(id) && at.y < floorY - JUMP_HEIGHT;
    if (partial && horizontal(start, at) >= 1 && !at.swim && !visits.has(id) && !hole && missing.size) {
      // A frontier down a hole is not worth walking into: what looks closer
      // to the goal from below may have no way back up. Prefer frontiers at
      // the start's level or above.
      const score = remaining(at) + costs.get(id) * 0.15 + Math.max(0, start.y - at.y - 1) * 3;
      if (score < best) {
        best = score;
        frontier = at;
      }
    }
    for (const { node, cost: step } of moves) {
      if (!safe(node) || blocked.has(`${id}>${key(node)}`)) continue;
      const cost = costs.get(id) + step + dread(node),
        nextId = key(node);
      if ((costs.get(nextId) ?? Infinity) <= cost) continue;
      costs.set(nextId, cost);
      previous.set(nextId, at);
      if (committed.has(id) || at.y - node.y > JUMP_HEIGHT) committed.add(nextId);
      else committed.delete(nextId);
      open.push({ p: node, score: cost + remaining(node) });
    }
  }
  return frontier ? path(frontier) : null;
}

// The open list: lowest score first, in log time, so planning stays well inside its deadline
// even on a machine the game's software renderer is starving.
export class Heap {
  items: { p: any; score: number }[] = [];
  get size() {
    return this.items.length;
  }
  push(item) {
    const a = this.items;
    a.push(item);
    for (let i = a.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (a[parent].score <= a[i].score) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }
  pop() {
    const a = this.items,
      top = a[0],
      last = a.pop();
    if (a.length && last) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < a.length && a[l].score < a[m].score) m = l;
        if (r < a.length && a[r].score < a[m].score) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}
