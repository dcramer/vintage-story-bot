const movementEpsilon = 0.05;
const discontinuityDistance = 32;
const stepLength = 0.75;
const gatheredGoals = new Set(['collect_item', 'forage', 'gather', 'harvest']);
const craftedGoals = new Set(['clayform', 'craft', 'knap']);

const finitePoint = point =>
  point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z) && Number.isFinite(point.dimension);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const rounded = value => Math.round(value * 10) / 10;

function inventoryCounts(inventory) {
  const counts = new Map<string, number>();
  for (const owned of inventory?.inventories ?? [])
    for (const slot of owned?.slots ?? []) {
      if (!slot?.code || !Number.isFinite(slot.quantity) || slot.quantity <= 0) continue;
      // Vintage Story exposes ten playable hotbar slots; the rest are UI padding.
      if (owned.name === 'hotbar' && slot.slot >= 10) continue;
      counts.set(slot.code, (counts.get(slot.code) ?? 0) + Math.floor(slot.quantity));
    }
  return counts;
}

function acquisitionKind(goal) {
  if (goal === 'retrieve_body') return 'recovered';
  if (gatheredGoals.has(goal)) return 'gathered';
  if (craftedGoals.has(goal)) return 'crafted';
  return 'other';
}

// Measurements for one controller segment of one player life. State and
// inventory are inputs the controller already receives; metrics never poll or
// delay the game. The fleet service joins segments with the same life id.
export class RunMetrics {
  baseSegmentId: string;
  segmentId: string;
  segmentNumber = 0;
  life: any = null;
  inventory: Map<string, number> | null = null;
  constructor(segmentId: string) {
    this.baseSegmentId = segmentId;
    this.segmentId = segmentId;
  }
  start(lifeId, point, at, alive) {
    this.segmentId = `${this.baseSegmentId}:${++this.segmentNumber}`;
    this.life = {
      id: lifeId,
      startedAt: at,
      endedAt: alive ? null : at,
      alive,
      origin: { ...point },
      position: { ...point },
      farthest: { ...point },
      maxFromOrigin: 0,
      distance: 0,
      movementSamples: 0,
      discontinuities: 0,
      last: { at, point: { ...point } },
      items: new Map(),
    };
    this.inventory = null;
  }
  observeState(state, wall = Date.now()) {
    const lifeId = state?.life?.session,
      point = state?.position,
      at = Number.isFinite(state?.observedAt) ? state.observedAt : wall,
      alive = state.alive !== false;
    if (typeof lifeId !== 'string' || !lifeId || !finitePoint(point)) return null;
    let transition = false;
    // The game session id remains stable across respawns. An observed revival,
    // not a changed session id, is the boundary between survival runs.
    if (!this.life || this.life.id !== lifeId || (!this.life.alive && alive)) {
      this.start(lifeId, point, at, alive);
      transition = true;
    } else if (at >= this.life.last.at) {
      const prior = this.life.last.point;
      if (point.dimension !== prior.dimension) this.life.discontinuities++;
      else {
        const moved = distance(prior, point);
        if (moved > discontinuityDistance) this.life.discontinuities++;
        else if (moved >= movementEpsilon) {
          this.life.distance += moved;
          this.life.movementSamples++;
        }
      }
      const fromOrigin = point.dimension === this.life.origin.dimension ? horizontal(this.life.origin, point) : 0;
      if (fromOrigin > this.life.maxFromOrigin) {
        this.life.maxFromOrigin = fromOrigin;
        this.life.farthest = { ...point };
      }
      this.life.position = { ...point };
      this.life.last = { at, point: { ...point } };
      if (alive !== this.life.alive) transition = true;
      this.life.alive = alive;
      if (!alive) this.life.endedAt ??= at;
    }
    return { data: this.view(), transition };
  }
  observeInventory(inventory, goal: string | null = null) {
    if (!this.life) return null;
    const next = inventoryCounts(inventory);
    if (this.inventory) {
      const kind = acquisitionKind(goal);
      for (const [code, quantity] of next) {
        const gain = quantity - (this.inventory.get(code) ?? 0);
        if (gain <= 0) continue;
        const row = this.life.items.get(code) ?? { code, gained: 0, gathered: 0, crafted: 0, recovered: 0, other: 0 };
        row.gained += gain;
        row[kind] += gain;
        this.life.items.set(code, row);
      }
    }
    this.inventory = next;
    return this.view();
  }
  view() {
    if (!this.life) return null;
    const allItems = [...this.life.items.values()];
    const items = allItems.sort((a, b) => b.gained - a.gained || a.code.localeCompare(b.code)).slice(0, 64);
    const totals = allItems.reduce(
      (sum, row) => {
        for (const key of ['gained', 'gathered', 'crafted', 'recovered', 'other']) sum[key] += row[key];
        return sum;
      },
      { gained: 0, gathered: 0, crafted: 0, recovered: 0, other: 0 },
    );
    const observedAt = this.life.last.at;
    return {
      version: 1,
      segmentId: this.segmentId,
      lifeId: this.life.id,
      segmentStartedAt: this.life.startedAt,
      observedAt,
      endedAt: this.life.endedAt,
      alive: this.life.alive,
      origin: this.life.origin,
      position: this.life.position,
      farthest: this.life.farthest,
      durationMs: Math.max(0, (this.life.endedAt ?? observedAt) - this.life.startedAt),
      distance: rounded(this.life.distance),
      movementSamples: this.life.movementSamples,
      estimatedSteps: Math.round(this.life.distance / stepLength),
      maxFromOrigin: rounded(this.life.maxFromOrigin),
      discontinuities: this.life.discontinuities,
      items: { ...totals, byCode: items },
    };
  }
}
