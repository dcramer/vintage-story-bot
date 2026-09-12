export const key = p => `${Math.floor(p.x)},${Math.round(p.y * 16)},${Math.floor(p.z)}`;
const cellKey = (x, y, z) => `${x},${y},${z}`;
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const normalize = n => ((n % 360) + 360) % 360;
export const angle = (a, b) => normalize(a - b + 180) - 180;
export const lookAt = (eye, p) => ({
  yawDegrees: normalize((Math.atan2(p.x - eye.x, p.z - eye.z) * 180) / Math.PI),
  pitchDegrees: (-Math.atan2(p.y - eye.y, horizontal(eye, p)) * 180) / Math.PI,
});

// The world as a player reasons about it: a grid of blocks. A cell is a
// place to stand when it has a floor and enough free cells above for the
// body; moves between cells are a walk, a step, a jump up one block, or a
// drop of up to three. Water and fire are walls, unknown is a wall, and a
// pit is simply a set of cells the search cannot leave. Water one block deep
// over solid ground is waded through at a cost (a wet node); deeper water is
// swum only when a route allows it (a swim node); fire is never entered.
// Beside water only a one-block step down is allowed.
export const BODY_HEIGHT = 1.85;
export const STEP_HEIGHT = 0.6; // Vintage Story auto-steps sub-block heights; a full block needs a jump.
// A jump clears a block and a thin layer on it (forest floor, snow, sticks), not a block and a slab.
export const JUMP_HEIGHT = 1.25;
export const MAX_DROP = 3.05; // No fall damage at three blocks; deeper is never planned.
export const JUMP_HEADROOM = 2.3; // Body top rises about one block during a jump.
export const WADE_COST = 3; // Shallow water is slow and cold; a route prefers dry ground.
export const SWIM_COST = 6;
// Feet sit about half a block below the surface cell's floor while swimming.
export const SWIM_DEPTH = 0.5;
const cardinals = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const diagonals = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const around = [...cardinals, ...diagonals];

// This is the bot's map: what it has seen stays until a block change is
// reported or the memory is very old. The mod's eye forgetting a cell it
// no longer keeps in range is not a reason for the player to forget it.
export const REMEMBER_MS = 7 * 24 * 60 * 60 * 1000;

import { Bounded } from './bounded.ts';

// The mod's trait word list for a cell; older memories and tests carry one hazard word or a boolean.
const traitsOf = value => (typeof value === 'string' ? value.split(',').filter(Boolean) : value === true ? ['shape'] : []);
export class TerrainMemory {
  cells = new Bounded<any>(262144);
  hazards = new Map();
  session = null;
  cursor = 0;
  now = 0;
  // Deep water is swum unless a route says otherwise; it costs enough that dry ground wins when there is any.
  swim = true;
  apply(batch, wall = Date.now()) {
    // A new mod session only restarts the delta stream; what the player
    // remembers of the world is not erased by the eye reopening.
    this.session = batch.session;
    this.cursor = batch.cursor;
    this.now = batch.clock;
    // A live row ends with the block's code (null for air); a null row ends with the reason it was dropped.
    for (const [x, y, z, at, hazard, boxes, tail] of batch.cells) {
      const id = cellKey(x, y, z);
      if (boxes === null) {
        if (tail !== 'forgot') this.forget(id);
      } else
        this.put({
          x,
          y,
          z,
          at,
          seenAt: wall,
          traits: traitsOf(hazard),
          code: tail ?? null,
          boxes: boxes.map(b => b.map((n, i) => n + [x, y, z][i % 3])),
        });
    }
    this.cells.bound(
      wall,
      cell => wall - cell.seenAt > REMEMBER_MS,
      id => this.forget(id),
    );
  }
  put(cell) {
    // What blocks the body: fire and lava always, water when nothing solid stands in it, a shape
    // whose geometry is not the cell's. Other traits (leaves, plant, climbable, tierN) are facts for goals.
    const has = trait => cell.traits.includes(trait);
    cell.hazard = has('fire') || has('lava') ? 'fire' : has('water') && !cell.boxes.length ? 'water' : has('shape') ? 'shape' : null;
    const id = cellKey(cell.x, cell.y, cell.z);
    this.cells.set(id, cell);
    if (cell.hazard) this.hazards.set(id, cell);
    else this.hazards.delete(id);
  }
  // Persistence: relative boxes and wall-clock stamps; the delta cursor is not part of memory.
  export() {
    return [...this.cells.values()].map(c => [
      c.x,
      c.y,
      c.z,
      c.seenAt,
      c.traits.join(',') || null,
      c.boxes.map(b => b.map((n, i) => n - [c.x, c.y, c.z][i % 3])),
      c.code ?? null,
    ]);
  }
  restore(rows) {
    this.cells.clear();
    this.hazards.clear();
    for (const [x, y, z, seenAt, hazard, boxes, code] of rows)
      this.put({
        x,
        y,
        z,
        at: 0,
        seenAt,
        traits: traitsOf(hazard),
        code: code ?? null,
        boxes: boxes.map(b => b.map((n, i) => n + [x, y, z][i % 3])),
      });
  }
  forget(id) {
    this.cells.delete(id);
    this.hazards.delete(id);
  }
  get(x, y, z) {
    return this.cells.get(cellKey(Math.floor(x), Math.floor(y), Math.floor(z)));
  }
  // Unknown cells worth looking at. A cell sealed under known solid ground
  // can never be seen by a sightline, so it is never a frontier: treating
  // it as one sends the bot to stare at a hillside forever.
  missing(missing, x, y, z) {
    if (!missing || this.buried(x, y, z)) return;
    missing.set(cellKey(Math.floor(x), Math.floor(y), Math.floor(z)), { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) });
  }
  // Sealed under known solid ground: the first known cell above it, up to six up (the eye never
  // records the earth under a hillside, so a known surface anywhere above settles it).
  buried(x, y, z) {
    for (let above = Math.floor(y) + 1; above <= Math.floor(y) + 6; above++) {
      const cell = this.get(x, above, z);
      if (!cell) continue;
      return !cell.hazard && cell.boxes.some(b => b[3] - b[0] > 0.99 && b[5] - b[2] > 0.99 && b[4] - b[1] > 0.99);
    }
    return false;
  }

  // Highest floor inside cell (x,y,z): null for air/unknown, Infinity for a
  // shape taller than its cell (fences, walls) that cannot be stood on.
  floor(x, y, z) {
    const cell = this.get(x, y, z);
    if (!cell?.boxes.length) return null;
    let top = -Infinity;
    for (const b of cell.boxes) {
      if (b[4] > y + 1.01) return Infinity;
      top = Math.max(top, b[4]);
    }
    return top > y ? top : null;
  }
  // Every cell of the column between two heights is known and free of
  // collision boxes and hazards: room for a body, a jump arc or a fall.
  clearBetween(x, z, from, to, missing?) {
    let ok = true;
    for (let y = Math.floor(from); y <= Math.floor(to - 0.001); y++) {
      const cell = this.get(x, y, z);
      if (!cell) {
        this.missing(missing, x, y, z);
        ok = false;
        continue;
      }
      if (cell.hazard) return false;
      if (cell.boxes.some(b => b[1] < to - 0.001 && b[4] > from + 0.001)) return false;
    }
    return ok;
  }
  // A place to stand: a floor in this cell and a body's worth of known free
  // space above it. A water cell over a solid block is a place to wade: feet
  // on that block, body above the water. A water cell over more water with
  // air above is a place to swim, when swimming is allowed.
  standable(x, y, z, missing?) {
    const cell = this.get(x, y, z);
    if (!cell) {
      this.missing(missing, x, y, z);
      return null;
    }
    if (cell.hazard === 'water') {
      const bed = this.get(x, y - 1, z);
      if (!bed) {
        this.missing(missing, x, y - 1, z);
        return null;
      }
      if (!bed.hazard && this.floor(x, y - 1, z) === y && this.clearBetween(x, z, y + 1, y + BODY_HEIGHT, missing))
        return { x: x + 0.5, y, z: z + 0.5, wet: true };
      if (this.swim && bed.hazard === 'water' && this.clearBetween(x, z, y + 1, y + 1 + BODY_HEIGHT - 1, missing))
        return { x: x + 0.5, y: y - SWIM_DEPTH, z: z + 0.5, swim: true };
      return null;
    }
    if (cell.hazard) return null;
    const top = this.floor(x, y, z);
    if (top === null || top === Infinity) return null;
    if (!this.clearBetween(x, z, top, top + BODY_HEIGHT, missing)) return null;
    return { x: x + 0.5, y: top, z: z + 0.5 };
  }
  // Standing places in a column within reach of a height: one jump up, three blocks down.
  levels(x, z, nearY, up = JUMP_HEIGHT, down = MAX_DROP, missing?) {
    const found = [];
    for (let y = Math.floor(nearY - down) - 1; y <= Math.floor(nearY + up); y++) {
      const node = this.standable(x, y, z, missing);
      if (node && node.y - nearY <= up && nearY - node.y <= down) found.push(node);
    }
    return found.sort((a, b) => Math.abs(a.y - nearY) - Math.abs(b.y - nearY));
  }
  nodeAt(x, z, nearY, up = JUMP_HEIGHT, down = MAX_DROP) {
    return this.levels(x, z, nearY, up, down)[0] ?? null;
  }
  // Compatibility for callers that think in coordinates.
  stand(x, z, nearY) {
    return this.nodeAt(Math.floor(x), Math.floor(z), nearY);
  }
  // The player's own footing: a standable cell under the body at its height.
  standingOn(p, tolerance = 0.35) {
    const x = Math.floor(p.x),
      z = Math.floor(p.z);
    return this.levels(x, z, p.y, tolerance, tolerance).some(node => Math.abs(node.y - p.y) <= tolerance);
  }
  // Water or fire touching a dry node's own level or the one below, in any direction.
  shore(node) {
    if (node.wet || node.swim) return false;
    const x = Math.floor(node.x),
      z = Math.floor(node.z),
      y = Math.floor(node.y - 0.01);
    for (const [dx, dz] of around) for (let dy = -1; dy <= 1; dy++) if (this.get(x + dx, y + dy, z + dz)?.hazard) return true;
    return false;
  }
  // Possible moves out of a node: walk/step to any neighbour, jump up one
  // block or drop up to three along a cardinal, never a diagonal corner cut
  // past something solid, never a drop beside water.
  moves(node, missing?) {
    const x = Math.floor(node.x),
      z = Math.floor(node.z),
      t = node.y,
      result = [];
    for (const [dx, dz] of around) {
      const diagonal = dx !== 0 && dz !== 0,
        d = diagonal ? Math.SQRT2 : 1;
      for (const to of this.levels(x + dx, z + dz, t, JUMP_HEIGHT, MAX_DROP, missing)) {
        const rise = to.y - t;
        let kind, cost;
        // Into or through water: a wade or a swim, never a jump or a drop.
        if (to.wet || to.swim || node.wet || node.swim) {
          if (diagonal && !this.cornerOpen(x, z, dx, dz, Math.max(t, to.y), missing)) continue;
          // Out of water a bank one block up is climbed with jump held; into deep water a fall of up to
          // three blocks is fine (the water takes it); into shallow water only a one-block step.
          if (rise > (node.swim ? 1.6 : JUMP_HEIGHT) || -rise > (to.swim ? MAX_DROP : 1.05)) continue;
          if (rise > STEP_HEIGHT && !this.clearBetween(x, z, t, t + JUMP_HEADROOM, missing)) continue;
          kind = to.swim ? 'swim' : to.wet ? 'wade' : rise > STEP_HEIGHT ? 'jump' : 'walk';
          cost = d + (to.swim ? SWIM_COST : to.wet ? WADE_COST : 1);
          result.push({ node: { ...to, move: kind }, cost });
          continue;
        }
        if (rise > STEP_HEIGHT) {
          if (
            !this.clearBetween(x, z, t, t + JUMP_HEADROOM, missing) ||
            !this.clearBetween(x + dx, z + dz, to.y, to.y + JUMP_HEADROOM - 0.3, missing)
          )
            continue;
          // A player jumps diagonally onto a block; only skip it if both
          // corner columns are blocked at the landing height (a true squeeze).
          if (diagonal && !this.cornerOpen(x, z, dx, dz, to.y, missing)) continue;
          kind = 'jump';
          cost = d + 1.5;
        } else if (rise < -STEP_HEIGHT) {
          // A one-block step down onto dry ground is an ordinary move even at the
          // water's edge; a longer fall beside water is not planned.
          if (diagonal || (-rise > 1.05 && this.shore(to)) || !this.clearBetween(x + dx, z + dz, to.y, t + BODY_HEIGHT, missing)) continue;
          // Stepping down is cheap; a stair of big drops is not a shortcut.
          kind = 'drop';
          cost = d + (-rise > 1.5 ? 1.5 * -rise : 0.4 * -rise);
        } else {
          // Level or step diagonal: don't cut a corner through a solid block;
          // one open orthogonal side is enough to round it, as a player does.
          if (diagonal && !this.cornerOpen(x, z, dx, dz, Math.max(t, to.y), missing)) continue;
          kind = rise > 0.05 ? 'step' : 'walk';
          cost = d + Math.abs(rise) * 0.3;
        }
        if (this.shore(to)) cost += 2;
        result.push({ node: { ...to, move: kind }, cost });
      }
    }
    return result;
  }
  // At least one of the two orthogonal columns beside a diagonal move is
  // clear through the body at the landing height, so the body can round the
  // corner on that side instead of clipping a solid block on both.
  cornerOpen(x, z, dx, dz, top, missing?) {
    return (
      this.clearBetween(x + dx, z, top + 0.01, top + BODY_HEIGHT, missing) || this.clearBetween(x, z + dz, top + 0.01, top + BODY_HEIGHT, missing)
    );
  }
  // Escape edges over a one-cell hole: the far cell stands, the middle one
  // does not, and there is room for the arc. Costly, so only ever a last resort.
  gapMoves(node, missing?) {
    const x = Math.floor(node.x),
      z = Math.floor(node.z),
      t = node.y,
      result = [];
    for (const [dx, dz] of cardinals) {
      if (this.levels(x + dx, z + dz, t, JUMP_HEIGHT, MAX_DROP).length) continue;
      if (!this.clearBetween(x, z, t, t + JUMP_HEADROOM, missing) || !this.clearBetween(x + dx, z + dz, t - 0.5, t + JUMP_HEADROOM, missing))
        continue;
      for (const to of this.levels(x + 2 * dx, z + 2 * dz, t, JUMP_HEIGHT, JUMP_HEIGHT, missing)) {
        if (this.shore(to) || !this.clearBetween(x + 2 * dx, z + 2 * dz, to.y, to.y + JUMP_HEADROOM - 0.3, missing)) continue;
        result.push({ node: { ...to, move: 'gap' }, cost: 2 + 4 });
      }
    }
    return result;
  }
  // Unknown cells a move out of this node would need: what to look at next.
  frontier(node) {
    const missing = new Map();
    this.moves(node, missing);
    this.gapMoves(node, missing);
    return missing;
  }
  views(p) {
    const x = Math.floor(p.x),
      z = Math.floor(p.z);
    const node = this.nodeAt(x, z, p.y, 0.5, 0.5) ?? { x: x + 0.5, y: p.y, z: z + 0.5 };
    const missing = this.frontier(node);
    this.clearBetween(x, z, p.y, p.y + BODY_HEIGHT, missing);
    return missing;
  }
  // Straight walk between two level nodes over standable cells only, for
  // merging checkpoints into one segment.
  lineWalkable(from, to) {
    if (Math.abs(from.y - to.y) > 0.05) return false;
    const steps = Math.ceil(horizontal(from, to) * 2);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps,
        x = from.x + (to.x - from.x) * t,
        z = from.z + (to.z - from.z) * t;
      const node = this.nodeAt(Math.floor(x), Math.floor(z), from.y, 0.05, 0.05);
      if (!node || Math.abs(node.y - from.y) > 0.05) return false;
      if (this.shore(node)) return false;
    }
    return true;
  }
}
