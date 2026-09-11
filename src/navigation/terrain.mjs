export const key = p => `${Math.floor(p.x)},${Math.round(p.y * 16)},${Math.floor(p.z)}`;
const cellKey = (x, y, z) => `${x},${y},${z}`;
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const normalize = n => (n % 360 + 360) % 360;
export const angle = (a, b) => normalize(a - b + 180) - 180;
export const lookAt = (eye, p) => ({ yawDegrees: normalize(Math.atan2(p.x - eye.x, p.z - eye.z) * 180 / Math.PI),
  pitchDegrees: -Math.atan2(p.y - eye.y, horizontal(eye, p)) * 180 / Math.PI });
const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const intersects = (a, b) => a[0] < b[3] - .001 && a[3] > b[0] + .001 && a[1] < b[4] - .001 && a[4] > b[1] + .001 && a[2] < b[5] - .001 && a[5] > b[2] + .001;

export class TerrainMemory {
  cells = new Map(); session = null; cursor = 0; now = 0;
  apply(batch) {
    if (batch.reset || batch.session !== this.session) this.cells.clear();
    this.session = batch.session; this.cursor = batch.cursor; this.now = batch.clock;
    for (const [x, y, z, at, hazard, boxes] of batch.cells) {
      const id = cellKey(x, y, z);
      if (boxes === null) this.cells.delete(id);
      else this.cells.set(id, { x, y, z, at, hazard, boxes: boxes.map(b => b.map((n, i) => n + [x, y, z][i % 3])) });
    }
    for (const [id, cell] of this.cells) if (this.now - cell.at > 120000) this.cells.delete(id);
    while (this.cells.size > 16384) this.cells.delete(this.cells.keys().next().value);
  }
  get(x, y, z) { return this.cells.get(cellKey(Math.floor(x), Math.floor(y), Math.floor(z))); }
  missing(missing, x, y, z) { missing?.set(cellKey(Math.floor(x), Math.floor(y), Math.floor(z)), { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }); }
  clear(p, w, h, missing) {
    const body = [p.x - w, p.y + .01, p.z - w, p.x + w, p.y + h, p.z + w];
    let unknown = false;
    for (let x = Math.floor(body[0]); x <= Math.floor(body[3] - .001); x++)
      for (let y = Math.floor(body[1]); y <= Math.floor(body[4] - .001); y++)
        for (let z = Math.floor(body[2]); z <= Math.floor(body[5] - .001); z++) {
          const cell = this.get(x, y, z);
          if (!cell) { unknown = true; this.missing(missing, x, y, z); }
          else if (cell.hazard || cell.boxes.some(b => intersects(b, body))) return false;
        }
    return !unknown || !!missing;
  }
  dry(p, w, h, margin = .55, missing, requireKnown = false) {
    // Keep planned body positions away from liquid/fire cells, including
    // hazards below a ledge. A dry block beside water two levels down is still
    // an unsafe checkpoint: slopes, gravity, and one bounded frame can carry the
    // player over that edge before the next observation arrives.
    const body = [p.x - w - margin, p.y - 2, p.z - w - margin,
      p.x + w + margin, p.y + h, p.z + w + margin];
    const feet = Math.floor(p.y);
    for (let x = Math.floor(body[0]); x <= Math.floor(body[3] - .001); x++)
      for (let y = Math.floor(body[1]); y <= Math.floor(body[4] - .001); y++)
        for (let z = Math.floor(body[2]); z <= Math.floor(body[5] - .001); z++) {
          const cell = this.get(x, y, z);
          // The margin is extra caution around the already-known body path,
          // not additional clearance geometry. Unknown margin/underground
          // cells are queued when possible but do not strand a freshly joined
          // player; clear() still requires the actual body volume to be known.
          if (!cell) {
            if (y >= feet || requireKnown) this.missing(missing, x, y, z);
            if (requireKnown) return false;
            continue;
          }
          else if (cell.hazard) return false;
        }
    return true;
  }
  hazardDistance(p, h) {
    let nearest = Infinity;
    for (const cell of this.cells.values()) {
      if (!cell.hazard || cell.y + 1 < p.y - 2 || cell.y > p.y + h) continue;
      const dx = Math.max(cell.x - p.x, 0, p.x - cell.x - 1);
      const dz = Math.max(cell.z - p.z, 0, p.z - cell.z - 1);
      nearest = Math.min(nearest, Math.hypot(dx, dz));
    }
    return nearest;
  }
  support(p, w, missing) {
    let count = 0;
    for (const dx of [-w, 0, w]) for (const dz of [-w, 0, w]) {
      const x = p.x + dx, z = p.z + dz;
      for (let y = Math.floor(p.y); y >= Math.floor(p.y - .06); y--) {
        const cell = this.get(x, y, z);
        if (!cell && missing && y < p.y) { this.missing(missing, x, y, z); count++; break; }
        if (cell && !cell.hazard && cell.boxes.some(b => Math.abs(b[4] - p.y) < .06 && x >= b[0] && x <= b[3] && z >= b[2] && z <= b[5])) { count++; break; }
      }
    }
    return count;
  }
  ground(p, w, drop, missing) {
    for (const dx of [-w, 0, w]) for (const dz of [-w, 0, w]) {
      const x = p.x + dx, z = p.z + dz;
      let found = false;
      for (let y = Math.floor(p.y - .01); y >= Math.floor(p.y - drop - .01); y--) {
        const cell = this.get(x, y, z);
        if (!cell) {
          if (!missing) return false;
          this.missing(missing, x, y, z); found = true; break;
        }
        if (cell.hazard) return false;
        if (cell.boxes.some(b => b[4] <= p.y + .01 && b[4] >= p.y - drop - .01 && x >= b[0] && x <= b[3] && z >= b[2] && z <= b[5])) { found = true; break; }
      }
      if (!found) return false;
    }
    return true;
  }
  groundSupport(p, w, drop) {
    let count = 0;
    for (const dx of [-w, 0, w]) for (const dz of [-w, 0, w]) {
      const x = p.x + dx, z = p.z + dz;
      for (let y = Math.floor(p.y - .01); y >= Math.floor(p.y - drop - .01); y--) {
        const cell = this.get(x, y, z);
        if (cell?.hazard) return -1;
        if (cell?.boxes.some(b => b[4] <= p.y + .01 && b[4] >= p.y - drop - .01 &&
            x >= b[0] && x <= b[3] && z >= b[2] && z <= b[5])) { count++; break; }
      }
    }
    return count;
  }
  stand(x, z, nearY, w, h, allowUnsafe = false) {
    const tops = new Set();
    for (let y = Math.floor(nearY) - 3; y <= Math.floor(nearY) + 1; y++) {
      const cell = this.get(x, y, z);
      if (cell && !cell.hazard) for (const b of cell.boxes)
        if (b[4] - nearY <= 1.01 && nearY - b[4] <= 2.01) tops.add(b[4]);
    }
    for (const y of [...tops].sort((a, b) => Math.abs(a - nearY) - Math.abs(b - nearY))) {
      const p = { x, y, z };
      if (this.support(p, w) === 9 && this.clear(p, w, h) && (allowUnsafe || this.dry(p, w, h))) return p;
    }
    return null;
  }
  traverse(from, to, w, h, recenter = false, missing, allowMarginEscape = false) {
    const rise = to.y - from.y;
    // One-block rises need a jump. A fully observed two-block descent is a
    // normal, damage-free drop; larger falls remain forbidden.
    if (rise > 1.06 || rise < -2.06) return false;
    const jump = rise > .05, travelY = Math.max(from.y, to.y) + (jump ? .25 : 0);
    const steps = Math.max(1, Math.ceil(distance(from, to) * 10));
    // A returning point can itself be inside the braking margin while the
    // player's actual body is dry. Permit a direct, supported exit toward a
    // safe endpoint, but never allow a path to re-enter the margin once clear.
    const startHazardDistance = this.hazardDistance(from, h);
    let support = 0, escapedHazardMargin = this.dry(from, w, h, .55, missing);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, p = { x: from.x + (to.x - from.x) * t, y: travelY, z: from.z + (to.z - from.z) * t };
      if (!this.clear(p, w, h, missing)) return false;
      const dry = this.dry(p, w, h, .55, missing);
      if (!dry && escapedHazardMargin) return false;
      if (dry) escapedHazardMargin = true;
      if (Math.abs(rise) < .05) {
        const n = this.support(p, w, missing);
        if (recenter ? n === 0 || n < support : n !== 9) return false;
        support = n;
      }
      if (rise < -.05) {
        if (recenter && -rise <= .125) {
          // Thin ground cover can leave a natively grounded player with only
          // partial observed support. Require continuous known contact while
          // recentering onto a fully supported, collision-checked endpoint.
          const n = this.groundSupport(p, w, -rise + .06);
          if (n <= 0) return false;
          support = n;
        } else if (!this.ground(p, w, -rise + .06, missing)) return false;
      }
      if (jump && !this.ground(p, w, travelY - from.y + .06, missing)) return false;
    }
    for (const end of [from, to]) for (let y = end.y; y <= travelY + .01; y += .1)
      if (!this.clear({ ...end, y }, w, h, missing)) return false;
    // A lower landing can conceal water or fire beneath a ledge. Unlike an
    // extra level-ground caution margin, every cell down to two blocks below
    // a descent endpoint must be observed before gravity is allowed to commit.
    if (rise < -.05 && !this.dry(to, w, h, .55, missing, true)) return false;
    const improvedMargin = allowMarginEscape && !escapedHazardMargin &&
      this.hazardDistance(to, h) > startHazardDistance + .05;
    return (escapedHazardMargin || improvedMargin) && this.support(to, w, missing) === 9;
  }
  jumpTraverse(from, to, w, h) {
    const span = horizontal(from, to), rise = to.y - from.y;
    // Only bridge one missing grid cell. Both banks and the complete jump arc
    // must already be known, clear and dry; this is not permission to leap
    // toward an unobserved or hazardous landing.
    if (span < 1.5 || span > 3.1 || rise > 1.01 || rise < -1.01 ||
        this.support(from, w) !== 9 || this.support(to, w) !== 9 ||
        !this.clear(to, w, h) || !this.dry(to, w, h, .55, undefined, true)) return false;
    const steps = Math.ceil(distance(from, to) * 12);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p = { x: from.x + (to.x - from.x) * t,
        y: from.y + rise * t + Math.sin(Math.PI * t) * .8,
        z: from.z + (to.z - from.z) * t };
      if (!this.clear(p, w, h) || !this.dry(p, w, h, .55, undefined, true)) return false;
    }
    return true;
  }
  frontier(p, w, h) {
    const result = new Map();
    for (const [dx, dz] of directions) {
      const x = p.x + dx, z = p.z + dz;
      for (let y = Math.floor(p.y) - 3; y <= Math.floor(p.y) + 1; y++) {
        const cell = this.get(x, y, z);
        if (cell?.hazard) continue;
        const tops = cell ? cell.boxes.map(b => b[4]) : [y + 1];
        for (const top of tops.filter(top => top - p.y <= 1.01 && p.y - top <= 2.01)) {
          const missing = new Map();
          if (this.traverse(p, { x, y: top, z }, w, h, false, missing)) for (const [id, value] of missing) result.set(id, value);
        }
      }
    }
    return result;
  }
  views(p, w, h) {
    const missing = this.frontier({ x: Math.floor(p.x) + .5, y: p.y, z: Math.floor(p.z) + .5 }, w, h);
    this.clear(p, w, h, missing); this.support(p, w, missing);
    return missing;
  }
}
