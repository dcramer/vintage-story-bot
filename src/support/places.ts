// Where the bot has walked and where its walks failed, by 16x16 area, shared by
// every goal for the session: a search does not pick the same far bank twice
// because a new goal started, and a leg that failed once is not replayed by the
// next one. Walked areas are dull for exploring; failed destinations are dear to
// the rough route and skipped by searches. Both fade after twenty minutes.
export const area = p => `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`;
export const PLACE_MS = 20 * 60 * 1000;

export class Places {
  walkedAreas = new Map<string, { n: number; at: number }>();
  failedAreas = new Map<string, { n: number; at: number }>();
  // Where each kind of search was heading when nothing was in sight, so a
  // search restarted after a flight or a night carries on the same way.
  frontiers = new Map<string, { x: number; y: number; z: number; at: number }>();
  now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  private bump(map: Map<string, { n: number; at: number }>, id: string, amount: number) {
    const now = this.now();
    map.set(id, { n: (map.get(id)?.n ?? 0) + amount, at: now });
    if (map.size > 4096) this.prune(now);
  }
  private count(map: Map<string, { n: number; at: number }>, id: string) {
    const entry = map.get(id);
    if (!entry) return 0;
    if (this.now() - entry.at > PLACE_MS) {
      map.delete(id);
      return 0;
    }
    return entry.n;
  }
  walk(p, amount = 1) {
    this.bump(this.walkedAreas, area(p), amount);
  }
  fail(p, amount = 1) {
    this.bump(this.failedAreas, area(p), amount);
  }
  walked(p) {
    return this.count(this.walkedAreas, area(p));
  }
  failed(p) {
    return this.count(this.failedAreas, area(p));
  }
  // Anything known about the area: it was walked, or walks to it failed.
  known(p) {
    return this.walked(p) > 0 || this.failed(p) > 0;
  }
  frontier(kind: string) {
    const entry = this.frontiers.get(kind);
    if (!entry) return null;
    if (this.now() - entry.at > PLACE_MS) {
      this.frontiers.delete(kind);
      return null;
    }
    return entry;
  }
  setFrontier(kind: string, point: { x: number; y: number; z: number }) {
    this.frontiers.set(kind, { x: point.x, y: point.y, z: point.z, at: this.now() });
  }
  clearFrontier(kind: string) {
    this.frontiers.delete(kind);
  }
  prune(now = this.now()) {
    for (const map of [this.walkedAreas, this.failedAreas]) {
      for (const [id, entry] of map) if (now - entry.at > PLACE_MS) map.delete(id);
      while (map.size > 4096) map.delete(map.keys().next().value);
    }
    for (const [kind, entry] of this.frontiers) if (now - entry.at > PLACE_MS) this.frontiers.delete(kind);
  }
  summary() {
    return { walked: this.walkedAreas.size, failed: this.failedAreas.size, frontiers: Object.fromEntries(this.frontiers) };
  }
}
