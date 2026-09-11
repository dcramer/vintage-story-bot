export const key = p => `${Math.floor(p.x)},${Math.round(p.y * 16)},${Math.floor(p.z)}`;
const cellKey = (x, y, z) => `${x},${y},${z}`;
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const normalize = n => (n % 360 + 360) % 360;
export const angle = (a, b) => normalize(a - b + 180) - 180;
export const lookAt = (eye, p) => ({ yawDegrees: normalize(Math.atan2(p.x - eye.x, p.z - eye.z) * 180 / Math.PI),
  pitchDegrees: -Math.atan2(p.y - eye.y, horizontal(eye, p)) * 180 / Math.PI });

// The world as a player reasons about it: a grid of blocks. A cell is a
// place to stand when it has a floor and enough free cells above for the
// body; moves between cells are a walk, a step, a jump up one block, or a
// drop of up to three. Water and fire are walls, unknown is a wall, and a
// pit is simply a set of cells the search cannot leave.
export const BODY_HEIGHT = 1.85;
export const STEP_HEIGHT = .6;   // Vintage Story auto-steps sub-block heights; a full block needs a jump.
export const JUMP_HEIGHT = 1.05;
export const MAX_DROP = 3.05;    // No fall damage at three blocks; deeper is never planned.
export const JUMP_HEADROOM = 2.3; // Body top rises about one block during a jump.
const cardinals = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const diagonals = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const around = [...cardinals, ...diagonals];

// This is the bot's map: what it has seen stays until a block change is
// reported or the memory is very old. The mod's eye forgetting a cell it
// no longer keeps in range is not a reason for the player to forget it.
export const REMEMBER_MS = 30 * 60 * 1000;
export class TerrainMemory {
  cells = new Map(); hazards = new Map(); session = null; cursor = 0; now = 0; capacity = 262144;
  apply(batch) {
    if (batch.reset || batch.session !== this.session) { this.cells.clear(); this.hazards.clear(); }
    this.session = batch.session; this.cursor = batch.cursor; this.now = batch.clock;
    for (const [x, y, z, at, hazard, boxes, reason] of batch.cells) {
      const id = cellKey(x, y, z);
      if (boxes === null) { if (reason !== 'forgot') this.forget(id); }
      else {
        const cell = { x, y, z, at, hazard, boxes: boxes.map(b => b.map((n, i) => n + [x, y, z][i % 3])) };
        this.cells.set(id, cell);
        if (hazard) this.hazards.set(id, cell); else this.hazards.delete(id);
      }
    }
    if (this.cells.size > this.capacity || (this.now - (this.prunedAt ?? 0)) > 60000) {
      this.prunedAt = this.now;
      for (const [id, cell] of this.cells) if (this.now - cell.at > REMEMBER_MS) this.forget(id);
      while (this.cells.size > this.capacity) this.forget(this.cells.keys().next().value);
    }
  }
  forget(id) { this.cells.delete(id); this.hazards.delete(id); }
  get(x, y, z) { return this.cells.get(cellKey(Math.floor(x), Math.floor(y), Math.floor(z))); }
  // Unknown cells worth looking at. A cell sealed under known solid ground
  // can never be seen by a sightline, so it is never a frontier: treating
  // it as one sends the bot to stare at a hillside forever.
  missing(missing, x, y, z) {
    if (!missing || this.buried(x, y, z)) return;
    missing.set(cellKey(Math.floor(x), Math.floor(y), Math.floor(z)), { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) });
  }
  buried(x, y, z) {
    for (let above = Math.floor(y) + 1; above <= Math.floor(y) + 3; above++) {
      const cell = this.get(x, above, z);
      if (!cell) continue;
      return !cell.hazard && cell.boxes.some(b => b[3] - b[0] > .99 && b[5] - b[2] > .99 && b[4] - b[1] > .99);
    }
    return false;
  }

  // Highest floor inside cell (x,y,z): null for air/unknown, Infinity for a
  // shape taller than its cell (fences, walls) that cannot be stood on.
  floor(x, y, z) {
    const cell = this.get(x, y, z);
    if (!cell || !cell.boxes.length) return null;
    let top = -Infinity;
    for (const b of cell.boxes) { if (b[4] > y + 1.01) return Infinity; top = Math.max(top, b[4]); }
    return top > y ? top : null;
  }
  // Every cell of the column between two heights is known and free of
  // collision boxes and hazards: room for a body, a jump arc or a fall.
  clearBetween(x, z, from, to, missing) {
    let ok = true;
    for (let y = Math.floor(from); y <= Math.floor(to - .001); y++) {
      const cell = this.get(x, y, z);
      if (!cell) { this.missing(missing, x, y, z); ok = false; continue; }
      if (cell.hazard) return false;
      if (cell.boxes.some(b => b[1] < to - .001 && b[4] > from + .001)) return false;
    }
    return ok;
  }
  // A place to stand: a floor in this cell and a body's worth of known free space above it.
  standable(x, y, z, missing) {
    const cell = this.get(x, y, z);
    if (!cell) { this.missing(missing, x, y, z); return null; }
    if (cell.hazard) return null;
    const top = this.floor(x, y, z);
    if (top === null || top === Infinity) return null;
    if (!this.clearBetween(x, z, top, top + BODY_HEIGHT, missing)) return null;
    return { x: x + .5, y: top, z: z + .5 };
  }
  // Standing places in a column within reach of a height: one jump up, three blocks down.
  levels(x, z, nearY, up = JUMP_HEIGHT, down = MAX_DROP, missing) {
    const found = [];
    for (let y = Math.floor(nearY - down) - 1; y <= Math.floor(nearY + up); y++) {
      const node = this.standable(x, y, z, missing);
      if (node && node.y - nearY <= up && nearY - node.y <= down) found.push(node);
    }
    return found.sort((a, b) => Math.abs(a.y - nearY) - Math.abs(b.y - nearY));
  }
  nodeAt(x, z, nearY, up = JUMP_HEIGHT, down = MAX_DROP) { return this.levels(x, z, nearY, up, down)[0] ?? null; }
  // Compatibility for callers that think in coordinates.
  stand(x, z, nearY) { return this.nodeAt(Math.floor(x), Math.floor(z), nearY); }
  // The player's own footing: a standable cell under the body at its height.
  standingOn(p, tolerance = .35) {
    const x = Math.floor(p.x), z = Math.floor(p.z);
    return this.levels(x, z, p.y, tolerance, tolerance).some(node => Math.abs(node.y - p.y) <= tolerance);
  }
  // Water or fire touching the node's own level or the one below, in any direction.
  shore(node) {
    const x = Math.floor(node.x), z = Math.floor(node.z), y = Math.floor(node.y - .01);
    for (const [dx, dz] of around) for (let dy = -1; dy <= 1; dy++)
      if (this.get(x + dx, y + dy, z + dz)?.hazard) return true;
    return false;
  }
  // Possible moves out of a node: walk/step to any neighbour, jump up one
  // block or drop up to three along a cardinal, never a diagonal corner cut
  // past something solid, never a drop beside water.
  moves(node, missing) {
    const x = Math.floor(node.x), z = Math.floor(node.z), t = node.y, result = [];
    for (const [dx, dz] of around) {
      const diagonal = dx !== 0 && dz !== 0, d = diagonal ? Math.SQRT2 : 1;
      for (const to of this.levels(x + dx, z + dz, t, JUMP_HEIGHT, MAX_DROP, missing)) {
        const rise = to.y - t;
        let kind, cost;
        if (rise > STEP_HEIGHT) {
          if (diagonal || !this.clearBetween(x, z, t, t + JUMP_HEADROOM, missing) ||
              !this.clearBetween(x + dx, z + dz, to.y, to.y + JUMP_HEADROOM - .3, missing)) continue;
          kind = 'jump'; cost = d + 1.5;
        } else if (rise < -STEP_HEIGHT) {
          if (diagonal || this.shore(to) || !this.clearBetween(x + dx, z + dz, to.y, t + BODY_HEIGHT, missing)) continue;
          // Stepping down is cheap; a stair of big drops is not a shortcut.
          kind = 'drop'; cost = d + (-rise > 1.5 ? 1.5 * -rise : .4 * -rise);
        } else {
          if (diagonal) {
            const low = Math.min(t, to.y), high = Math.max(t, to.y);
            if (!this.clearBetween(x + dx, z, low + .01, high + BODY_HEIGHT, missing) ||
                !this.clearBetween(x, z + dz, low + .01, high + BODY_HEIGHT, missing)) continue;
          }
          kind = rise > .05 ? 'step' : 'walk'; cost = d + Math.abs(rise) * .3;
        }
        if (this.shore(to)) cost += 2;
        result.push({ node: { ...to, move: kind }, cost });
      }
    }
    return result;
  }
  // Escape edges over a one-cell hole: the far cell stands, the middle one
  // does not, and there is room for the arc. Costly, so only ever a last resort.
  gapMoves(node, missing) {
    const x = Math.floor(node.x), z = Math.floor(node.z), t = node.y, result = [];
    for (const [dx, dz] of cardinals) {
      if (this.levels(x + dx, z + dz, t, JUMP_HEIGHT, MAX_DROP).length) continue;
      if (!this.clearBetween(x, z, t, t + JUMP_HEADROOM, missing) || !this.clearBetween(x + dx, z + dz, t - .5, t + JUMP_HEADROOM, missing)) continue;
      for (const to of this.levels(x + 2 * dx, z + 2 * dz, t, JUMP_HEIGHT, JUMP_HEIGHT, missing)) {
        if (this.shore(to) || !this.clearBetween(x + 2 * dx, z + 2 * dz, to.y, to.y + JUMP_HEADROOM - .3, missing)) continue;
        result.push({ node: { ...to, move: 'gap' }, cost: 2 + 4 });
      }
    }
    return result;
  }
  // Unknown cells a move out of this node would need: what to look at next.
  frontier(node) {
    const missing = new Map();
    this.moves(node, missing); this.gapMoves(node, missing);
    return missing;
  }
  views(p) {
    const x = Math.floor(p.x), z = Math.floor(p.z);
    const node = this.nodeAt(x, z, p.y, .5, .5) ?? { x: x + .5, y: p.y, z: z + .5 };
    const missing = this.frontier(node);
    this.clearBetween(x, z, p.y, p.y + BODY_HEIGHT, missing);
    return missing;
  }
  // Straight walk between two level nodes over standable cells only, for
  // merging checkpoints into one segment.
  lineWalkable(from, to) {
    if (Math.abs(from.y - to.y) > .05) return false;
    const steps = Math.ceil(horizontal(from, to) * 2);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, x = from.x + (to.x - from.x) * t, z = from.z + (to.z - from.z) * t;
      const node = this.nodeAt(Math.floor(x), Math.floor(z), from.y, .05, .05);
      if (!node || Math.abs(node.y - from.y) > .05) return false;
      if (this.shore(node)) return false;
    }
    return true;
  }
}
