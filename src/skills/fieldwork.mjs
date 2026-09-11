import { horizontal, lookAt, normalize } from '../navigation/terrain.mjs';
import { findRoute } from '../navigation/planner.mjs';
import { fleeTarget, nearestThreat } from './threats.mjs';

export const area = p => `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`;
export const sightRange = 64;
export const temporalStormUnsafe = state => ['imminent', 'active'].includes(state.condition?.temporalStorm?.phase);
// Failed destinations should rotate a directed search through nearby lateral
// options, but repeated failures must never make a known goal's exact opposite
// preferable. Two failures saturate the soft penalty below a 180-degree turn.
export const explorationScore = (offset, visits = 0) => Math.min(visits, 2) * 1.5 + Math.abs(offset) / 45;
// Keep obstruction bypasses local. A full-range sideways or reverse target can
// dominate the journey even though only a few blocks were needed to clear a
// tree line or cliff edge.
export const explorationDistance = (distance, offset) => distance *
  (Math.abs(offset) < 1 ? 1 : Math.abs(offset) <= 45 ? .75 : Math.abs(offset) <= 90 ? .4 : .2);

// Shared session guard, observed-resource memory and travel; no transport/lease ownership.
export class Fieldwork {
  initial = null;
  latest = null;
  moved = 0;
  searched = 0;
  heading = 0;
  attempts = 0;
  foodRecoveryAuthorized = false;
  visits = new Map();
  seen = new Map();
  rejected = new Map();
  constructor(env, { signal, timeoutMs, sprint = false, wait = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
    this.env = env;
    this.signal = signal;
    this.timeoutMs = timeoutMs;
    this.sprint = sprint;
    this.wait = wait;
    this.now = now;
    this.started = now();
  }
  check() {
    if (this.signal?.aborted) throw Error('Goal cancelled');
    if (this.timeoutMs !== undefined && this.now() - this.started >= this.timeoutMs) throw Error('Requested deadline reached');
  }
  alertsSafe(state) {
    if (!this.recoveringFood) this.foodRecoveryAuthorized = false;
    else if (state.life.alerts.includes('low_food')) this.foodRecoveryAuthorized = true;
    return state.life.alerts.every(alert => alert === 'low_food' ||
      alert === 'low_health' && this.foodRecoveryAuthorized);
  }
  async send(request) {
    this.check();
    const result = await this.env.send(request);
    if (!result.ok) throw Error(result.error ?? 'Game action refused');
    return result;
  }
  guard(state) {
    this.check();
    if (!state.ok || !state.alive || !state.controlReady || !this.alertsSafe(state) ||
        state.motion.swimming || state.motion.feetInLiquid || state.mounted)
      throw Error('Gameplay interruption: life, controls or liquid');
    const initial = this.initial;
    if (initial && (state.player.uid !== initial.player.uid || state.life.session !== initial.life.session ||
        state.life.lastDamageAt !== initial.life.lastDamageAt || state.position.dimension !== initial.position.dimension))
      throw Error('Gameplay interruption: damage or session changed');
    this.latest = state;
    return state;
  }
  async observe(sync = false) {
    this.check();
    return this.guard(sync ? await this.env.sync() : await this.send({ action: 'observe' }));
  }
  async start(capabilities = []) {
    this.initial = await this.observe(true);
    if (!this.initial.motion.onGround) throw Error('Start grounded');
    for (const feature of ['nearby_awareness', ...capabilities])
      if (!this.initial.capabilities.includes(feature)) throw Error(`Update mod: ${feature} required`);
    this.heading = this.initial.orientation.yawDegrees;
    this.visits.set(area(this.initial.position), 1);
  }
  report(phase, extra = {}) {
    this.env.report?.({ phase, moved: +this.moved.toFixed(1), searched: this.searched, ...extra });
  }
  async aim(angles) {
    await this.observe();
    await this.env.aim(angles, { allowStarvingRecovery: this.recoveringFood });
    await this.observe();
  }
  async scan(radius, match, kind = 'all') {
    let cursor;
    const objects = [];
    // A scan is read-only and stationary. Guard once around the paged sweep
    // instead of spending an extra game-thread round trip on every page.
    await this.observe();
    do {
      const filter = Array.isArray(match) ? { matches: match } : { match };
      const page = await this.env.send({ action: 'scan', kind, ...filter, radius, limit: 32, ...(cursor ? { cursor } : {}) });
      if (page.code === 'scan_expired') break;
      if (!page.ok) throw Error(page.error ?? 'Scan refused');
      objects.push(...page.objects);
      for (const object of page.objects) this.seen.set(object.key, { ...object, seenAt: this.now() });
      cursor = page.more ? page.cursor : null;
    } while (cursor);
    await this.observe();
    this.searched++;
    this.prune();
    return objects;
  }
  prune() {
    for (const [id, object] of this.seen) if (this.now() - object.seenAt > 120000) this.seen.delete(id);
    while (this.seen.size > 1024) this.seen.delete(this.seen.keys().next().value);
    for (const [id, until] of this.rejected) if (until <= this.now()) this.rejected.delete(id);
    while (this.rejected.size > 1024) this.rejected.delete(this.rejected.keys().next().value);
  }
  reject(object, ms = 30000) { this.rejected.set(object.key, this.now() + ms); }
  penalize(target, amount = 1) {
    this.visits.set(area(target), (this.visits.get(area(target)) ?? 0) + amount);
  }
  resetExploration(turn = 45) {
    this.visits.clear();
    this.visits.set(area(this.latest.position), 1);
    this.heading = normalize(this.heading + turn);
  }
  targets(predicate) {
    this.prune();
    return [...this.seen.values()].filter(o => predicate(o) && !this.rejected.has(o.key))
      .sort((a, b) => horizontal(a.point, this.latest.position) - horizontal(b.point, this.latest.position));
  }
  async walk(target, yieldWhen) {
    const before = await this.observe();
    this.report('walking', { target });
    // Software-rendered remote clients commonly need about three seconds per
    // block over uneven ground. Preserve a hard two-minute ceiling, but do not
    // abort a visibly progressing local food leg just before its next viewpoint.
    const timeoutMs = Math.min(120000, Math.max(20000, Math.ceil(horizontal(before.position, target) * 3000)));
    const food = before.vitals?.hunger;
    const emergencyFoodSearch = this.recoveringFood && food?.max > 0 &&
      food.current / food.max < .2 && food.current / food.max >= .1;
    const result = await this.env.navigate({ ...target, dimension: 0, timeoutMs,
      sprint: target.sprint ?? (this.sprint || emergencyFoodSearch),
      ...(emergencyFoodSearch ? { emergency: true } : {}) }, state => {
      this.guard(state);
      return yieldWhen?.(state);
    }, { allowStarvingRecovery: this.recoveringFood });
    const after = await this.observe(true);
    this.moved += horizontal(before.position, after.position);
    this.visits.set(area(after.position), (this.visits.get(area(after.position)) ?? 0) + 1);
    if (result.state === 'arrived' && area(target) !== area(after.position))
      this.penalize(target);
    else if (!['arrived', 'yielded'].includes(result.state))
      // A failed exploration leg is evidence about that destination, even if
      // the player never left the current 16x16 area. Penalize it so the next
      // deterministic attempt tries a different heading instead of replaying
      // the same blocked leg six times.
      this.visits.set(area(target), (this.visits.get(area(target)) ?? 0) + 1);
    while (this.visits.size > 4096) this.visits.delete(this.visits.keys().next().value);
    if (result.state === 'cancelled') throw Error(`Navigation interrupted: ${result.reason}`);
    if (result.state !== 'arrived' && result.state !== 'yielded') this.report('rerouting', { reason: result.reason });
    if (horizontal(before.position, after.position) > 1) this.heading = lookAt(before.position, after.position).yawDegrees;
    else if (result.state !== 'yielded') this.heading = normalize(this.heading + 90);
    return result;
  }
  async evadeThreat(clearStall) {
    let fled = false;
    while (true) {
      this.check();
      const threat = nearestThreat(this.latest);
      if (!threat) return fled;
      const target = fleeTarget(this.latest.position, threat);
      this.report('evading', { threat: threat.code, distance: +horizontal(this.latest.position, threat.point).toFixed(1), target });
      const before = { ...this.latest.position };
      const result = await this.walk(target, state => nearestThreat(state) ? null : 'threat_cleared');
      if (!['arrived', 'yielded'].includes(result.state) && horizontal(before, this.latest.position) <= 2)
        await clearStall?.(target);
      fled = true;
    }
  }
  approach(object, exclude = null) {
    const { position: p, body: { halfWidth: w, height: h } } = this.latest;
    const candidates = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const q = this.env.map.stand(Math.floor(object.point.x) + .5 + dx, Math.floor(object.point.z) + .5 + dz, object.point.y, w, h);
      if (!q || horizontal(p, q) < .5 || object.kind === 'item' && horizontal(q, object.point) > .8 || exclude?.(q)) continue;
      const route = findRoute(this.env.map, p, q, w, h, { partial: false });
      if (route) candidates.push({ q: { ...q, arrivalRadius: .1 }, score: route.length + horizontal(q, object.point) * 2 });
    }
    return candidates.sort((a, b) => a.score - b.score)[0]?.q;
  }
  explore(toward, maxDistance = sightRange * .75) {
    const p = this.latest.position;
    const direction = toward ? lookAt(p, toward).yawDegrees : this.heading;
    const distance = toward ? Math.min(maxDistance, horizontal(p, toward)) : maxDistance;
    const candidates = [0, 45, -45, 90, -90, 180].map(offset => {
      const legDistance = toward ? explorationDistance(distance, offset) : distance;
      const radians = normalize(direction + offset) * Math.PI / 180;
      const q = { x: Math.floor(p.x + Math.sin(radians) * legDistance) + .5, y: p.y,
        z: Math.floor(p.z + Math.cos(radians) * legDistance) + .5, horizontalOnly: true,
        arrivalRadius: Math.min(4, Math.max(.75, legDistance / 12)) };
      return { q, score: explorationScore(offset, this.visits.get(area(q)) ?? 0) };
    });
    for (const { q } of candidates.sort((a, b) => a.score - b.score))
      if (findRoute(this.env.map, p, q, this.latest.body.halfWidth, this.latest.body.height)) return q;
    return candidates[this.attempts++ % candidates.length].q;
  }
}
