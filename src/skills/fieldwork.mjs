import { horizontal, lookAt, normalize } from '../navigation/terrain.mjs';
import { findRoute } from '../navigation/planner.mjs';

export const area = p => `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`;
export const sightRange = 64;

// Shared session guard, observed-resource memory and travel; no transport/lease ownership.
export class Fieldwork {
  initial = null;
  latest = null;
  moved = 0;
  searched = 0;
  heading = 0;
  attempts = 0;
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
  async send(request) {
    this.check();
    const result = await this.env.send(request);
    if (!result.ok) throw Error(result.error ?? 'Game action refused');
    return result;
  }
  guard(state) {
    this.check();
    if (!state.ok || !state.alive || !state.controlReady || state.life.alerts.some(a => a !== 'low_food') ||
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
    await this.env.aim(angles);
    await this.observe();
  }
  async scan(radius, match, kind = 'all') {
    let cursor;
    const objects = [];
    // A scan is read-only and stationary. Guard once around the paged sweep
    // instead of spending an extra game-thread round trip on every page.
    await this.observe();
    do {
      const page = await this.env.send({ action: 'scan', kind, match, radius, limit: 32, ...(cursor ? { cursor } : {}) });
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
  targets(predicate) {
    this.prune();
    return [...this.seen.values()].filter(o => predicate(o) && !this.rejected.has(o.key))
      .sort((a, b) => horizontal(a.point, this.latest.position) - horizontal(b.point, this.latest.position));
  }
  async walk(target, yieldWhen) {
    const before = await this.observe();
    this.report('walking', { target });
    const timeoutMs = Math.min(120000, Math.max(15000, Math.ceil(horizontal(before.position, target) * 2000)));
    const result = await this.env.navigate({ ...target, dimension: 0, timeoutMs, sprint: this.sprint }, state => {
      this.guard(state);
      return yieldWhen?.(state);
    });
    const after = await this.observe(true);
    this.moved += horizontal(before.position, after.position);
    this.visits.set(area(after.position), (this.visits.get(area(after.position)) ?? 0) + 1);
    if (result.state === 'arrived' && area(target) !== area(after.position))
      this.visits.set(area(target), (this.visits.get(area(target)) ?? 0) + 1);
    while (this.visits.size > 4096) this.visits.delete(this.visits.keys().next().value);
    if (result.state === 'cancelled') throw Error(`Navigation interrupted: ${result.reason}`);
    if (result.state !== 'arrived' && result.state !== 'yielded') this.report('rerouting', { reason: result.reason });
    if (horizontal(before.position, after.position) > 1) this.heading = lookAt(before.position, after.position).yawDegrees;
    else if (result.state !== 'yielded') this.heading = normalize(this.heading + 90);
    return result;
  }
  approach(object, exclude = null) {
    const { position: p, body: { halfWidth: w, height: h } } = this.latest;
    const candidates = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const q = this.env.map.stand(Math.floor(object.point.x) + .5 + dx, Math.floor(object.point.z) + .5 + dz, object.point.y, w, h);
      if (!q || horizontal(p, q) < .5 || object.kind === 'item' && horizontal(q, object.point) > .8 || exclude?.(q)) continue;
      const route = findRoute(this.env.map, p, q, w, h, { partial: false });
      if (route) candidates.push({ q, score: route.length + horizontal(q, object.point) * 2 });
    }
    return candidates.sort((a, b) => a.score - b.score)[0]?.q;
  }
  explore(toward) {
    const p = this.latest.position;
    const direction = toward ? lookAt(p, toward).yawDegrees : this.heading;
    const distance = toward ? Math.min(sightRange * .75, horizontal(p, toward)) : sightRange * .75;
    const candidates = [0, 45, -45, 90, -90, 180].map(offset => {
      const radians = normalize(direction + offset) * Math.PI / 180;
      const q = { x: Math.floor(p.x + Math.sin(radians) * distance) + .5, y: p.y,
        z: Math.floor(p.z + Math.cos(radians) * distance) + .5, horizontalOnly: true, arrivalRadius: 4 };
      return { q, score: (this.visits.get(area(q)) ?? 0) * 8 + Math.abs(offset) / 90 };
    });
    for (const { q } of candidates.sort((a, b) => a.score - b.score))
      if (findRoute(this.env.map, p, q, this.latest.body.halfWidth, this.latest.body.height)) return q;
    return candidates[this.attempts++ % candidates.length].q;
  }
}
