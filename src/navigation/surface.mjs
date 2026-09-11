import { horizontal, normalize } from './terrain.mjs';

// Long-range landscape memory: one sight-verified surface sample per column,
// from the snapshots the mod's eye returns with every sense, coarser with
// distance. This is what the player has seen, not the world: absent columns
// are unknown, never air or ground. Node owns the memory; the mod only says
// what is in view right now.
const columnKey = (x, z) => `${x},${z}`;
const steps = [1, 2, 4];
const directions = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export class SurfaceMemory {
  columns = new Map(); now = 0; sweeps = 0; ttlMs = 300000; capacity = 32768;
  apply(snapshot) {
    if (!snapshot) return 0;
    this.now = snapshot.clock ?? this.now;
    // Completed passes of the mod's eye over the current view.
    this.sweeps = snapshot.sweeps ?? this.sweeps;
    for (const [x, z, y, kind, step, code, at, color] of snapshot.columns ?? [])
      this.columns.set(columnKey(x, z), { x, z, y, kind, step, code, color, at: at ?? this.now });
    for (const [id, column] of this.columns) if (this.now - column.at > this.ttlMs) this.columns.delete(id);
    while (this.columns.size > this.capacity) this.columns.delete(this.columns.keys().next().value);
    return snapshot.columns?.length ?? 0;
  }
  get(x, z) { return this.columns.get(columnKey(Math.floor(x), Math.floor(z))); }
  // Nearest sampled column around a point, honouring the coarse rings.
  nearest(x, z, within = 4) {
    let best = null;
    for (let dx = -within; dx <= within; dx++) for (let dz = -within; dz <= within; dz++) {
      const column = this.get(Math.floor(x) + dx, Math.floor(z) + dz);
      if (!column) continue;
      const d = Math.hypot(column.x + .5 - x, column.z + .5 - z);
      if (!best || d < best.d) best = { column, d };
    }
    return best?.column ?? null;
  }
  // Standing columns only; water and fire are never route nodes and a column
  // beside water costs extra so rough routes keep off shorelines.
  neighbors(column) {
    const result = [];
    for (const [dx, dz] of directions) for (const step of steps) {
      const next = this.columns.get(columnKey(column.x + dx * step, column.z + dz * step));
      if (!next) continue;
      result.push(next);
      break;
    }
    return result;
  }
  shore(column) {
    if (column.shore !== undefined) return column.shore;
    column.shore = directions.some(([dx, dz]) => {
      const next = this.columns.get(columnKey(column.x + dx * column.step, column.z + dz * column.step));
      return next && (next.kind === 'water' || next.kind === 'hazard');
    });
    return column.shore;
  }
}

// Movement cost between two surveyed columns, or Infinity when the visible
// slope is beyond what walking can do. Adjacent columns follow the fine
// planner's limits (jump up one, drop two); coarse rings only bound the
// average slope, leaving the truth to the fine planner when the bot arrives.
export function edgeCost(surface, from, to, { canopyCost = 1, shoreCost = 2, slopeCost = 1.5 } = {}) {
  if (to.kind !== 'ground' && to.kind !== 'canopy') return Infinity;
  const d = Math.hypot(to.x - from.x, to.z - from.z), rise = to.y - from.y;
  if (d <= 1.5 ? rise > 1.06 || rise < -2.06 : Math.abs(rise) > d) return Infinity;
  return d + Math.abs(rise) * slopeCost + (to.kind === 'canopy' ? d * canopyCost : 0) +
    (surface.shore(to) ? shoreCost : 0);
}

// Coarse A* over surveyed columns. status: success reaches the goal column,
// partial ends at the known column nearest the goal that still makes progress,
// noPath when nothing visible leads anywhere. Mirrors mineflayer-pathfinder's
// partial-path semantics: a partial rough route is worth walking, then resurvey.
export function planRoughRoute(surface, start, goal, { budget = 4096, penalty = () => 0, minimumProgress = 4 } = {}) {
  const origin = surface.nearest(start.x, start.z, 2);
  if (!origin) return { status: 'noPath', reason: 'origin_unknown', checkpoints: [] };
  const target = surface.nearest(goal.x, goal.z, 4);
  const goalReached = column => Math.hypot(column.x + .5 - goal.x, column.z + .5 - goal.z) <= Math.max(2, column.step);
  const remaining = column => Math.hypot(column.x + .5 - goal.x, column.z + .5 - goal.z);
  const costs = new Map([[origin, 0]]), previous = new Map(), closed = new Set();
  const open = [{ column: origin, score: remaining(origin) }];
  let best = null, bestScore = Infinity;
  const path = end => {
    const list = [end];
    while (previous.has(end)) { end = previous.get(end); list.push(end); }
    return list.reverse();
  };
  while (open.length && closed.size < budget) {
    open.sort((a, b) => b.score - a.score);
    const { column } = open.pop();
    if (closed.has(column)) continue;
    closed.add(column);
    if (goalReached(column) || target && column === target)
      return { status: 'success', checkpoints: simplify(path(column)), cost: costs.get(column), explored: closed.size };
    const progress = remaining(origin) - remaining(column);
    if (progress >= minimumProgress) {
      const score = remaining(column) + costs.get(column) * .15;
      if (score < bestScore) { bestScore = score; best = column; }
    }
    for (const next of surface.neighbors(column)) {
      const step = edgeCost(surface, column, next);
      if (step === Infinity) continue;
      const cost = costs.get(column) + step + penalty(next);
      if ((costs.get(next) ?? Infinity) <= cost) continue;
      costs.set(next, cost); previous.set(next, column);
      open.push({ column: next, score: cost + remaining(next) });
    }
  }
  if (!best) return { status: 'noPath', reason: closed.size >= budget ? 'budget' : 'no_progress', checkpoints: [], explored: closed.size };
  return { status: 'partial', checkpoints: simplify(path(best)), cost: costs.get(best), explored: closed.size };
}

// Keep bends and a checkpoint at least every twelve blocks; drop collinear
// samples so a leg can aim at the far end of a straight stretch.
export function simplify(columns, maxSpan = 12, turnDegrees = 20) {
  const points = columns.map(c => ({ x: c.x + .5, y: c.y, z: c.z + .5, kind: c.kind, step: c.step }));
  if (points.length <= 2) return points;
  const result = [points[0]];
  let heading = null, span = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1], p = points[i];
    const next = normalize(Math.atan2(p.x - prev.x, p.z - prev.z) * 180 / Math.PI);
    const turn = heading === null ? 0 : Math.abs(normalize(next - heading + 180) - 180);
    span += horizontal(prev, p);
    if (i === points.length - 1 || turn > turnDegrees || span >= maxSpan) {
      // A bend belongs to the previous point; the current one starts the new heading.
      if (turn > turnDegrees && result[result.length - 1] !== prev) result.push(prev);
      if (i === points.length - 1 || span >= maxSpan) { result.push(p); span = 0; }
      else span = horizontal(prev, p);
    }
    heading = next;
  }
  if (result[result.length - 1] !== points[points.length - 1]) result.push(points[points.length - 1]);
  return result;
}

// The next leg to hand the fine navigator: the farthest rough-route checkpoint
// within reach, so short bounded legs still follow the surveyed line.
export function nextLeg(checkpoints, from, { minDistance = 6, maxDistance = 40 } = {}) {
  let chosen = null, along = 0;
  for (let i = 1; i < checkpoints.length; i++) {
    along += horizontal(checkpoints[i - 1], checkpoints[i]);
    const direct = horizontal(from, checkpoints[i]);
    if (direct > maxDistance || along > maxDistance * 1.5) break;
    if (direct >= minDistance || i === checkpoints.length - 1) chosen = checkpoints[i];
  }
  return chosen ?? (checkpoints.length > 1 && horizontal(from, checkpoints[checkpoints.length - 1]) <= maxDistance ? checkpoints[checkpoints.length - 1] : null);
}
