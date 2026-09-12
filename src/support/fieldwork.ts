import { findRoute } from '../runtime/navigation/planner.ts';
import { nextLeg, planRoughRoute } from '../runtime/navigation/surface.ts';
import { distance, horizontal, lookAt, normalize } from '../runtime/navigation/terrain.ts';
import { Gleaner } from './gleaning.ts';
import { fleeTarget, nearestThreat, nearestUnclearedThreat } from './threats.ts';

export const area = p => `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`;
export const sightRange = 64;
// Beyond this the fine navigator's observed disk cannot see the destination;
// walk looks at the landscape first. Native move_to accepts up to 128 blocks.
export const sightHorizon = 12;
export const navigationReach = 48;
export const temporalStormUnsafe = state => ['imminent', 'active'].includes(state.condition?.temporalStorm?.phase);
// Failed destinations should rotate a directed search through nearby lateral
// options, but repeated failures must never make a known goal's exact opposite
// preferable. Two failures saturate the soft penalty below a 180-degree turn.
export const explorationScore = (offset, visits = 0) => Math.min(visits, 2) * 1.5 + Math.abs(offset) / 45;
// Keep obstruction bypasses local. A full-range sideways or reverse target can
// dominate the journey even though only a few blocks were needed to clear a
// tree line or cliff edge.
export const explorationDistance = (distance, offset) =>
  distance * (Math.abs(offset) < 1 ? 1 : Math.abs(offset) <= 45 ? 0.75 : Math.abs(offset) <= 90 ? 0.4 : 0.2);
export const explorationReach = (towardDistance, maxDistance, minDistance = 0) => Math.min(maxDistance, Math.max(minDistance, towardDistance));

// Shared session guard, observed-resource memory and travel; no transport/control ownership.
export class Fieldwork {
  env: any;
  gleaner: any;
  hurtAt: any;
  lastLook: any;
  now: any;
  roughRouteStatus: any;
  signal: any;
  sprint: any;
  started: any;
  stopWhenHurt: any;
  swim: any;
  timeoutMs: any;
  wait: any;
  initial = null;
  latest = null;
  moved = 0;
  searched = 0;
  heading = 0;
  attempts = 0;
  foodRecoveryAuthorized = false;
  visits = new Map();
  seen = new Map();
  skipped = new Map();
  events: any[] = [];
  alertsAt = '';
  lookedAround: any = null;
  recoveringFood = false;
  constructor(
    env,
    {
      signal,
      timeoutMs,
      sprint = false,
      swim = true,
      stopWhenHurt = false,
      wants = env.wants,
      wait = ms => new Promise(r => setTimeout(r, ms)),
      now = Date.now,
    }: any = {},
  ) {
    this.env = env;
    // Things to pick up on the way, whatever the goal: set by the brain or the wants action.
    this.gleaner = Array.isArray(wants) && wants.length ? new Gleaner(this, wants) : null;
    this.signal = signal;
    this.timeoutMs = timeoutMs;
    this.sprint = sprint;
    this.swim = swim;
    this.stopWhenHurt = stopWhenHurt;
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
    return state.life.alerts.every(alert => alert === 'low_food' || (alert === 'low_health' && this.foodRecoveryAuthorized));
  }
  async send(request) {
    this.check();
    const result = await this.env.send(request);
    if (!result.ok) throw Error(result.error ?? 'Game action refused');
    return result;
  }
  // What ends a goal outright: death, lost controls, a life alert, deep water
  // without leave to swim, a changed player or world. Being hurt does not:
  // it is noted as an event the goal and the brain can read, and the work
  // goes on, unless the goal asked to stop when hurt.
  assess(state, { controls = true } = {}) {
    this.check();
    if (!state.ok || !state.alive || (controls && !state.controlReady) || (state.motion.swimming && !this.swim) || state.mounted)
      throw Error('Gameplay interruption: life, controls or liquid');
    const initial = this.initial;
    if (
      initial &&
      (state.player.uid !== initial.player.uid ||
        state.life.session !== initial.life.session ||
        state.position.dimension !== initial.position.dimension)
    )
      throw Error('Gameplay interruption: session changed');
    const alerts = (state.life?.alerts ?? []).join(',');
    if (initial && alerts !== this.alertsAt) {
      this.alertsAt = alerts;
      if (alerts) this.event('alert', { alerts: state.life.alerts, health: state.vitals?.health?.current ?? null });
    }
    if (initial && state.life.lastDamageAt !== this.hurtAt) {
      this.hurtAt = state.life.lastDamageAt;
      this.event('hurt', { health: state.vitals?.health?.current ?? null });
      if (this.stopWhenHurt) throw Error('Gameplay interruption: hurt');
    }
    this.latest = state;
    return state;
  }
  guard(state) {
    return this.assess(state);
  }
  // Things that happened during the goal, newest last, bounded; reported with progress.
  event(type, extra = {}) {
    this.events.push({ type, at: this.now(), ...extra });
    while (this.events.length > 16) this.events.shift();
    this.report(type, extra);
  }
  async observe(sync = false) {
    this.check();
    return this.guard(sync ? await this.env.sync() : await this.send({ action: 'observe' }));
  }
  async start(features = []) {
    this.initial = await this.env.sync();
    this.hurtAt = this.initial.life?.lastDamageAt ?? null;
    this.alertsAt = (this.initial.life?.alerts ?? []).join(',');
    this.guard(this.initial);
    if (!this.initial.motion.onGround) throw Error('Start grounded');
    for (const feature of ['nearby_awareness', ...features])
      if (!this.initial.capabilities.includes(feature)) throw Error(`Update mod: ${feature} required`);
    this.heading = this.initial.orientation.yawDegrees;
    this.visits.set(area(this.initial.position), 1);
  }
  report(phase, extra: any = {}) {
    this.env.report?.({
      phase,
      moved: +this.moved.toFixed(1),
      searched: this.searched,
      ...(this.events.length ? { events: this.events.slice(-4) } : {}),
      ...extra,
    });
  }
  async aim(angles) {
    await this.observe();
    await this.env.aim(angles, { allowStarvingRecovery: this.recoveringFood });
    await this.observe();
  }
  // Turn the head toward a point and let the mod's vision stream fill the
  // landscape memory, the way a player takes in a valley before crossing it.
  // Read-only and stationary; the mod reports only what a line of sight reaches
  // and Node never asks for a column it did not look at.
  async look(toward?) {
    if (!this.seeing) return 0;
    const p = this.latest.position,
      before = this.env.surface.columns.size;
    const look = toward ? lookAt({ ...p, y: p.y + this.latest.body.eyeHeight }, toward) : { yawDegrees: this.heading, pitchDegrees: 0 };
    await this.aim({ yawDegrees: look.yawDegrees, pitchDegrees: Math.max(-30, Math.min(30, look.pitchDegrees)) });
    await this.settle();
    return Math.max(0, this.env.surface.columns.size - before);
  }
  // Wait for the eye to finish one pass over the current view: a few hundred
  // milliseconds at normal frame rates, a few seconds on a software renderer.
  async settle(timeoutMs = 4000) {
    const start = this.env.surface?.sweeps ?? 0,
      until = this.now() + timeoutMs;
    for (let reads = 0; reads < 40; reads++) {
      await this.observe(true);
      if ((this.env.surface?.sweeps ?? 0) > start || this.now() >= until) return;
      await this.wait(150);
    }
  }
  // Next bounded leg along the seen rough route toward a far goal, or null
  // when nothing visible leads there. Penalized 16x16 areas cost extra so a
  // leg that already failed on the ground is not replanned identically.
  roughRoute(goal, { maxDistance = 40 } = {}) {
    if (!this.env.surface) return null;
    const p = this.latest.position;
    // An area a leg already failed in costs as much as a thirty-block detour
    // per failure: the coarse map cannot see the cliff that stopped the leg.
    const plan = planRoughRoute(this.env.surface, p, goal, { penalty: column => (this.visits.get(area(column)) ?? 0) * 30 });
    const point = plan.checkpoints.length ? nextLeg(plan.checkpoints, p, { maxDistance }) : null;
    this.roughRouteStatus = {
      status: plan.status,
      reason: plan.reason,
      checkpoints: plan.checkpoints.length,
      explored: plan.explored,
      end: plan.checkpoints.at(-1) ? { x: plan.checkpoints.at(-1).x, z: plan.checkpoints.at(-1).z } : null,
    };
    if (!point || horizontal(p, point) < 2) return null;
    return { x: point.x, y: point.y, z: point.z, horizontalOnly: true, arrivalRadius: Math.min(3, Math.max(1, point.step)), roughRoute: plan.status };
  }
  // Whether the vision feed carries entities, items and watched blocks.
  get attentive() {
    return !!this.env.sightings && !!this.latest?.capabilities?.includes('sightings');
  }
  // Look for something: set the eye's attention to the codes, wait for one
  // pass over the current view, and read what the feed has seen. Nothing
  // is queried; a mod without the feed falls back to the paged scan read.
  async scan(radius, match?, kind = 'all') {
    const matches = Array.isArray(match) ? match : match ? [match] : [];
    await this.observe();
    if (!this.attentive) return this.scanView(radius, match, kind);
    this.env.watch?.(matches);
    await this.settle();
    const p = this.latest.position,
      eye = { ...p, y: p.y + (this.latest.body?.eyeHeight ?? 1.6) };
    const reach = this.latest.pickingRange ?? 4.5;
    const kinds = { all: null, blocks: 'block', items: 'item', entities: 'entity' };
    const objects = this.env.sightings
      .visible(kinds[kind] ?? null)
      .filter(s => !matches.length || matches.some(m => s.code.toLowerCase().includes(m.toLowerCase())))
      .map(s => {
        const far = distance(eye, s.point);
        return {
          kind: s.kind,
          key: s.key,
          code: s.code,
          point: s.point,
          distance: +far.toFixed(2),
          quantity: s.extra?.quantity ?? null,
          access: s.extra?.access ?? null,
          facts: s.extra?.facts ?? null,
          how: s.how,
          source: far <= 8 ? 'nearby' : 'sight',
          withinPickingRange: far <= reach,
          look: lookAt(eye, s.point),
        };
      })
      .filter(o => o.distance <= radius)
      .sort((a, b) => a.distance - b.distance);
    for (const object of objects) this.seen.set(object.key, { ...object, seenAt: this.now() });
    this.searched++;
    this.prune();
    return objects;
  }
  // Turn through a full circle from where the bot stands, letting the vision
  // feed take in every direction before choosing where to go, the way a
  // player looks around from a rise. Then read what is now remembered.
  async lookAround(match?, kind = 'blocks', radius = sightRange) {
    if (!this.seeing || !this.attentive) return this.scan(radius, match, kind);
    // One full circle per spot: the view does not change by looking again from the same place.
    const p0 = this.latest.position;
    if (this.lookedAround && this.now() - this.lookedAround.at < 20000 && horizontal(p0, this.lookedAround.position) < 2)
      return this.scan(radius, match, kind);
    this.lookedAround = { position: { ...p0 }, at: this.now() };
    this.env.watch?.(Array.isArray(match) ? match : match ? [match] : []);
    const p = this.latest.position,
      start = this.latest.orientation.yawDegrees;
    for (const offset of [60, 120, 180, 240, 300, 0]) {
      await this.aim({ yawDegrees: normalize(start + offset), pitchDegrees: -10 });
      await this.settle();
      if (horizontal(p, this.latest.position) > 1) break;
    }
    this.report('looking_around');
    return this.scan(radius, match, kind);
  }
  async scanView(radius, match?, kind = 'all') {
    let cursor;
    const objects = [];
    // A scan is read-only and stationary. Guard once around the paged sweep
    // instead of spending an extra game-thread round trip on every page.
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
    for (const [id, until] of this.skipped) if (until <= this.now()) this.skipped.delete(id);
    while (this.skipped.size > 1024) this.skipped.delete(this.skipped.keys().next().value);
  }
  skip(object, ms = 30000) {
    this.skipped.set(object.key, this.now() + ms);
  }
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
    return [...this.seen.values()]
      .filter(o => predicate(o) && !this.skipped.has(o.key))
      .sort((a, b) => horizontal(a.point, this.latest.position) - horizontal(b.point, this.latest.position));
  }
  // Whether long-range sight is available: surface memory in the controller
  // and a mod that streams vision. Without it, walk is a single fine leg.
  get seeing() {
    return !!this.env.surface && !!this.latest?.capabilities?.includes('surface_vision');
  }
  // Walk toward a target the way a player does: beyond the fine navigator's
  // horizon, look at the landscape first and follow a rough route leg by leg,
  // looking again from each new viewpoint. Near targets are one fine leg. A far
  // target with nothing visible leading there ends as no_visible_route so
  // the caller's stuck recovery (leaf clearing, exploration) takes over.
  // A walk that also picks up what the bot wants when it passes within reach.
  async walk(target, pauseWhen?) {
    const gleaner = this.gleaner;
    const pause = gleaner ? state => pauseWhen?.(state) ?? gleaner.pauseWhen(state) : pauseWhen;
    for (let stops = 0; ; stops++) {
      const result = await this.walkOn(target, pause);
      if (result.state !== 'paused' || result.reason !== 'want_in_reach' || stops >= 4) return result;
      await gleaner.tend();
    }
  }
  async walkOn(target, pauseWhen?) {
    await this.observe();
    // Fleeing never pauses to look around; the flee target is already mapped.
    if (!this.seeing || target.leg || nearestThreat(this.latest)) return this.leg(target, pauseWhen);
    for (let legs = 0; legs < 8; legs++) {
      const p = this.latest.position,
        remaining = horizontal(p, target);
      if (remaining <= sightHorizon) return this.leg(target, pauseWhen);
      const roughRoute = await this.lookAhead(target);
      if (!roughRoute) {
        if (remaining <= navigationReach) return this.leg(target, pauseWhen);
        this.visits.set(area(target), (this.visits.get(area(target)) ?? 0) + 1);
        this.report('rerouting', { reason: 'no_visible_route', roughRoute: this.roughRouteStatus });
        return { state: 'blocked', reason: 'no_visible_route', roughRoute: this.roughRouteStatus };
      }
      const result = await this.leg({ ...roughRoute, leg: true }, pauseWhen);
      if (result.state !== 'arrived') {
        // A surface leg failing within fine range means the coarse map missed
        // terrain the fine grid can see (a dip, a hole). Let the fine navigator
        // try the real target once; it routes around what the surface can't.
        if (horizontal(this.latest.position, target) <= navigationReach) return this.leg(target, pauseWhen);
        return result;
      }
    }
    return this.leg(target, pauseWhen);
  }
  // Look toward the target; when the straight view shows no full rough route,
  // glance left and right as well before choosing a line.
  async lookAhead(target) {
    const p = this.latest.position;
    const recent = this.lastLook && this.now() - this.lastLook.at < 15000 && horizontal(p, this.lastLook.position) < 2;
    if (!recent) {
      await this.look(target);
      this.lastLook = { position: p, at: this.now(), sweep: false };
    }
    let roughRoute = this.roughRoute(target);
    if ((!roughRoute || this.roughRouteStatus.status !== 'success') && !this.lastLook.sweep) {
      this.lastLook.sweep = true;
      const direction = lookAt(p, target).yawDegrees;
      for (const offset of [-50, 50]) {
        const radians = (normalize(direction + offset) * Math.PI) / 180;
        await this.look({ x: p.x + Math.sin(radians) * 32, y: p.y, z: p.z + Math.cos(radians) * 32 });
      }
      roughRoute = this.roughRoute(target);
    }
    this.report(roughRoute ? 'rough_route' : 'no_rough_route', {
      roughRoute: this.roughRouteStatus,
      ...(roughRoute ? { leg: { x: roughRoute.x, y: roughRoute.y, z: roughRoute.z } } : {}),
    });
    return roughRoute;
  }
  async leg(target, pauseWhen?) {
    let before = await this.observe();
    // A leg starts from the ground: after a step down or a jump the body can
    // be airborne for a moment when the previous leg ends.
    for (let waits = 0; waits < 6 && !before.motion.onGround && !before.motion.swimming && !before.motion.feetInLiquid; waits++) {
      await this.wait(250);
      before = await this.observe(true);
    }
    // Horizontal-only legs carry a surveyed height that is only a guess at
    // distance; the navigator ignores it, so give it the real one.
    if (target.horizontalOnly) target = { ...target, y: before.position.y };
    this.report('walking', { target });
    // Software-rendered remote clients commonly need about three seconds per
    // block over uneven ground. Preserve a hard two-minute ceiling, but do not
    // abort a visibly progressing local food leg just before its next viewpoint.
    const timeoutMs = Math.min(120000, Math.max(20000, Math.ceil(horizontal(before.position, target) * 3000)));
    const food = before.vitals?.hunger;
    const emergencyFoodSearch = this.recoveringFood && food?.max > 0 && food.current / food.max < 0.2 && food.current / food.max >= 0.1;
    const result = await this.env.navigate(
      {
        ...target,
        dimension: 0,
        timeoutMs,
        sprint: target.sprint ?? (this.sprint || emergencyFoodSearch),
        ...(emergencyFoodSearch ? { emergency: true } : {}),
      },
      state => {
        this.guard(state);
        return pauseWhen?.(state);
      },
      { allowStarvingRecovery: this.recoveringFood },
    );
    const after = await this.observe(true);
    this.moved += horizontal(before.position, after.position);
    this.visits.set(area(after.position), (this.visits.get(area(after.position)) ?? 0) + 1);
    if (result.state === 'arrived' && area(target) !== area(after.position)) this.penalize(target);
    else if (!['arrived', 'paused'].includes(result.state))
      // A failed exploration leg is evidence about that destination, even if
      // the player never left the current 16x16 area. Penalize it so the next
      // deterministic attempt tries a different heading instead of replaying
      // the same blocked leg six times.
      this.visits.set(area(target), (this.visits.get(area(target)) ?? 0) + 1);
    while (this.visits.size > 4096) this.visits.delete(this.visits.keys().next().value);
    // A walk the mod released or the eye cancelled without a hard reason is a
    // pause: the goal observes again and carries on from where it stands.
    if (result.state === 'cancelled') {
      if (/control_lost|identity_life_or_control_changed/.test(result.reason ?? '') && this.env.map) {
        await this.observe();
        return { ...result, state: 'paused', reason: 'released' };
      }
      throw Error(`Navigation interrupted: ${result.reason}`);
    }
    if (result.state !== 'arrived' && result.state !== 'paused') this.report('rerouting', { reason: result.reason });
    if (horizontal(before.position, after.position) > 1) this.heading = lookAt(before.position, after.position).yawDegrees;
    else if (result.state !== 'paused') this.heading = normalize(this.heading + 90);
    return result;
  }
  async evadeThreat(unstick?) {
    let fled = false;
    while (true) {
      this.check();
      const threat = fled ? nearestUnclearedThreat(this.latest) : nearestThreat(this.latest);
      if (!threat) return fled;
      const target = fleeTarget(this.latest.position, threat);
      this.report('evading', { threat: threat.code, distance: +horizontal(this.latest.position, threat.point).toFixed(1), target });
      const before = { ...this.latest.position };
      const result = await this.walk(target, state => (nearestUnclearedThreat(state) ? null : 'threat_cleared'));
      if (!['arrived', 'paused'].includes(result.state) && horizontal(before, this.latest.position) <= 2) await unstick?.(target);
      fled = true;
    }
  }
  approach(object, exclude = null) {
    const {
      position: p,
      body: { halfWidth: w, height: h },
    } = this.latest;
    const candidates = [];
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++) {
        const q = this.env.map.stand(Math.floor(object.point.x) + 0.5 + dx, Math.floor(object.point.z) + 0.5 + dz, object.point.y, w, h);
        if (!q || horizontal(p, q) < 0.5 || (object.kind === 'item' && horizontal(q, object.point) > 0.8) || exclude?.(q)) continue;
        const route = findRoute(this.env.map, p, q, w, h, { partial: false });
        if (route) candidates.push({ q: { ...q, arrivalRadius: 0.1 }, score: route.length + horizontal(q, object.point) * 2 });
      }
    return candidates.sort((a, b) => a.score - b.score)[0]?.q;
  }
  explore(toward?, maxDistance = sightRange * 0.75, minDistance = 0) {
    const p = this.latest.position;
    const direction = toward ? lookAt(p, toward).yawDegrees : this.heading;
    // A horizontally close target may still be high above or below us. Its
    // caller can request a wider search so directed candidates reach around
    // the base of a cliff instead of circling inside the same tiny footprint.
    const distance = toward ? explorationReach(horizontal(p, toward), maxDistance, minDistance) : maxDistance;
    const candidates = [0, 45, -45, 90, -90, 180].map(offset => {
      const legDistance = toward ? explorationDistance(distance, offset) : distance;
      const radians = (normalize(direction + offset) * Math.PI) / 180;
      const q = {
        x: Math.floor(p.x + Math.sin(radians) * legDistance) + 0.5,
        y: p.y,
        z: Math.floor(p.z + Math.cos(radians) * legDistance) + 0.5,
        horizontalOnly: true,
        arrivalRadius: Math.min(4, Math.max(0.75, legDistance / 12)),
      };
      return { q, score: explorationScore(offset, this.visits.get(area(q)) ?? 0) };
    });
    for (const { q } of candidates.sort((a, b) => a.score - b.score))
      if (findRoute(this.env.map, p, q, this.latest.body.halfWidth, this.latest.body.height)) return q;
    return candidates[this.attempts++ % candidates.length].q;
  }
}
