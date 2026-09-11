import { randomUUID } from 'node:crypto';
import { angle, distance, horizontal, key, lookAt, normalize } from './terrain.mjs';
import { findRoute } from './planner.mjs';
import { fleeTarget, nearbyThreats, nearbyUnclearedThreats } from '../skills/threats.mjs';

export class Navigation {
  id = randomUUID(); state = 'surveying'; reason = null;
  route = []; index = 0; replans = 0; segments = 0;
  blocked = new Set(); visits = new Map();
  lookingAt = null;
  jumpAt = 0; landing = false; nextPlanAt = 0;
  airborneDuringJump = false;
  steeringYaw = null; steeringAt = 0;
  evading = false; threat = null; threats = []; avoid = [];
  constructor(map, state, goal, now = Date.now()) {
    this.map = map; this.primaryTarget = this.target = goal;
    this.width = state.body.halfWidth; this.height = state.body.height; this.eyeHeight = state.body.eyeHeight;
    this.deadline = now + (goal.timeoutMs ?? 60000); this.surveyAt = this.progressAt = now;
    this.lastProgress = this.edgeStart = state.position;
  }
  get active() { return ['surveying', 'moving'].includes(this.state); }
  observe() {
    return { id: this.id, state: this.state, reason: this.reason, target: this.target,
      remainingCheckpoints: Math.max(0, this.route.length - this.index), replans: this.replans, segments: this.segments,
      cachedCells: this.map.cells.size, lookingAt: this.lookingAt, nextCheckpoint: this.nextCheckpoint,
      desiredYaw: this.desiredYaw, yawError: this.yawError, lastReplan: this.lastReplan, diagnostics: this.diagnostics,
      evading: this.evading, threat: this.threat, threats: this.threats };
  }
  finish(state, reason) { this.state = state; this.reason = reason; this.lookingAt = null; return null; }
  survey(now) {
    this.state = 'surveying'; this.surveyAt = now; this.jumpAt = 0; this.landing = false;
    this.airborneDuringJump = false;
    this.lookingAt = null; this.nextPlanAt = 0; this.lastYawError = undefined;
  }
  replan(p, now, reason) {
    this.lastReplan = reason;
    if (['stuck', 'jump_failed'].includes(reason)) this.blocked.add(`${key(this.edgeStart)}>${key(this.route[this.index])}`);
    if (++this.replans > 12) return this.finish('blocked', reason);
    this.survey(now); this.lastProgress = p; this.progressAt = now;
    return null;
  }
  tick(state, now = Date.now()) {
    if (!this.active) return null;
    if (now >= this.deadline) return this.finish('blocked', 'deadline');
    const p = state.position, grounded = state.motion.onGround, map = this.map, w = this.width, h = this.height;
    const threats = this.evading ? nearbyUnclearedThreats(state) : nearbyThreats(state);
    const nearby = threats[0] ?? null;
    if (!this.evading && nearby) {
      this.evading = true; this.threat = nearby; this.threats = threats;
      this.target = fleeTarget(p, threats); this.survey(now);
    } else if (this.evading && !nearby) {
      this.evading = false; this.threat = null; this.threats = [];
      this.avoid = []; this.target = this.primaryTarget; this.survey(now);
    } else if (this.evading) {
      this.threat = nearby; this.threats = threats;
    }
    this.avoid = threats.map(entity => ({ point: entity.point,
      minimumDistance: Math.max(0, horizontal(p, entity.point) - .5) }));
    if (grounded && horizontal(p, this.target) < (this.target.arrivalRadius ?? .3) && (this.target.horizontalOnly || Math.abs(p.y - this.target.y) < .1) && map.support(p, w) === 9)
      if (this.evading && nearby) { this.threat = nearby; this.target = fleeTarget(p, threats); this.survey(now); }
      else return this.finish('arrived', 'destination_reached');
    if (this.state === 'surveying') {
      if (!grounded) return now - this.surveyAt > 1000 ? this.finish('blocked', 'lost_support') : null;
      let planned = null;
      if (now >= this.nextPlanAt) {
        this.nextPlanAt = now + 300;
        planned = findRoute(map, p, this.target, w, h, this);
      }
      if (!planned) {
        if (now - this.surveyAt < 2500) {
          this.lookingAt = [...map.views(p, w, h).values()]
            .sort((a, b) => horizontal(a, this.target) - horizontal(b, this.target))[0] ?? null;
          // Nearby geometry samples independently of the camera; focus only changes sample priority.
          return { yawDegrees: lookAt(p, this.target).yawDegrees, pitchDegrees: 15, focus: this.lookingAt };
        }
        planned = findRoute(map, p, this.target, w, h, this);
      }
      if (!planned) {
        this.diagnostics = { missing: [...map.views(p, w, h).values()].slice(0, 24), supported: map.support(p, w), clear: map.clear(p, w, h) };
        return this.finish('blocked', 'no_observed_route');
      }
      this.route = planned; this.index = 0; this.state = 'moving'; this.lookingAt = null;
      this.lastProgress = this.edgeStart = p; this.progressAt = now;
    }
    const traverse = (from, to, recenter = false) => to.jumpGap && typeof map.jumpTraverse === 'function'
      ? map.jumpTraverse(from, to, w, h)
      : map.traverse(from, to, w, h, recenter, undefined,
        typeof map.dry === 'function' && !map.dry(from, w, h));
    const reached = checkpoint => {
      if (distance(p, checkpoint) < (checkpoint.recenter ? .1 : .3)) return true;
      if (checkpoint.recenter) return false;
      // A bounded frame can carry the player more than one block between slow
      // client samples. Accept a crossed intermediate checkpoint only while the
      // observed position remains close to its validated route segment.
      const dx = checkpoint.x - this.edgeStart.x, dz = checkpoint.z - this.edgeStart.z;
      const length = Math.hypot(dx, dz);
      const lateral = length > .01 ? Math.abs((p.x - checkpoint.x) * dz - (p.z - checkpoint.z) * dx) / length : Infinity;
      const overshoot = this.target.sprint ? 4 : 2.5;
      return horizontal(checkpoint, this.target) > 1 && Math.abs(p.y - checkpoint.y) < .1 &&
        horizontal(p, checkpoint) < overshoot && lateral < w + .2 && dx * dx + dz * dz > .01 &&
        (p.x - checkpoint.x) * dx + (p.z - checkpoint.z) * dz >= 0 && traverse(this.edgeStart, p);
    };
    let advancedCheckpoint = false;
    while (this.index < this.route.length && grounded && map.support(p, w) === 9 && reached(this.route[this.index])) {
      this.edgeStart = this.route[this.index++]; this.jumpAt = 0; this.landing = false; this.progressAt = now; this.lastProgress = p;
      advancedCheckpoint = true;
    }
    if (this.index >= this.route.length) {
      const id = key(p); this.visits.set(id, (this.visits.get(id) ?? 0) + 1);
      if (++this.segments >= 64 || this.visits.get(id) > 3) return this.finish('blocked', 'exploration_exhausted');
      this.survey(now); return null;
    }
    let skippedAhead = false;
    if (grounded && !this.jumpAt && !this.landing) for (let ahead = this.index + 1; ahead < this.route.length; ahead++) {
      const next = this.route[ahead];
      if (distance(p, next) > 5 || Math.abs(next.y - p.y) > .05 ||
          !traverse(p, next, this.index === 0) || this.blocked.has(`${key(p)}>${key(next)}`)) break;
      this.index = ahead; this.edgeStart = p; skippedAhead = true;
    }
    const next = this.route[this.index];
    this.nextCheckpoint = next;
    if (this.evading && !next.recenter && !this.avoid.every(item => horizontal(next, item.point) >= item.minimumDistance)) {
      this.target = fleeTarget(p, threats); this.survey(now); return null;
    }
    const nextSupport = map.support(next, w), nextClear = map.clear(next, w, h);
    if (nextSupport !== 9 || !nextClear) {
      this.diagnostics = { kind: 'checkpoint_invalid', point: next, support: nextSupport, clear: nextClear,
        dry: typeof map.dry !== 'function' || map.dry(next, w, h) };
      return grounded ? this.replan(p, now, 'terrain_changed') : this.finish('blocked', 'landing_changed');
    }
    if (this.jumpAt && !grounded) this.airborneDuringJump = true;
    if (this.jumpAt && grounded && this.airborneDuringJump && Math.abs(p.y - next.y) < .06) {
      this.jumpAt = 0; this.landing = true; this.airborneDuringJump = false;
    }
    // The live body is natively grounded: validate the remaining segment with
    // the tolerant support rule (some contact, never decreasing) instead of
    // demanding the full nine-point centre support a planned checkpoint has.
    // Off-centre positions over block edges are normal while walking and
    // must not read as changed terrain.
    const recenter = true;
    if (grounded && !this.jumpAt && !traverse(p, next, recenter)) {
      this.diagnostics = { kind: 'segment_invalid', from: p, point: next, recenter,
        fromDry: typeof map.dry !== 'function' || map.dry(p, w, h),
        dry: typeof map.dry !== 'function' || map.dry(next, w, h),
        fromHazardDistance: map.hazardDistance?.(p, h), hazardDistance: map.hazardDistance?.(next, h) };
      return this.replan(p, now, 'terrain_changed');
    }
    if (distance(p, this.lastProgress) > .12) { this.progressAt = now; this.lastProgress = p; this.lastYawError = undefined; }
    const desiredYaw = lookAt(p, next).yawDegrees;
    this.desiredYaw = desiredYaw;
    this.yawError = angle(desiredYaw, state.orientation.yawDegrees);
    const yawMagnitude = Math.abs(this.yawError);
    // Camera convergence is real progress on a software-rendered remote client.
    // A motionless camera still reaches the same bounded stuck timeout.
    if (this.lastYawError !== undefined && yawMagnitude < this.lastYawError - .5) this.progressAt = now;
    this.lastYawError = yawMagnitude;
    // Remote correction and low render rates can take several sensed frames to
    // turn an accepted input into visible motion. Keep the bounded control hold fast,
    // but do not discard a still-valid route after only a handful of samples.
    if (now - this.progressAt > 3000) return this.replan(p, now, 'stuck');
    const following = this.route[this.index + 1];
    const turn = following ? Math.abs(angle(lookAt(next, following).yawDegrees, desiredYaw)) : 0;
    // Short frames near steps and sharp bends; a diagonal-to-cardinal bend is
    // ordinary walking, not a tight turn.
    const tight = horizontal(p, next) < 3 && (Math.abs(next.y - p.y) > .05 || turn > 60);
    const durationMs = tight ? 180 : 500;
    // Ignore tiny pursuit corrections and ease bends while moving. For a
    // large stationary turn, request the route yaw directly: remote control
    // samples can be several seconds apart, and applying only 150ms worth of
    // rotation per sample otherwise spends tens of seconds standing still.
    // The branch below keeps forward released until the observed yaw catches
    // up, so this does not weaken route validation.
    if (this.steeringYaw === null || now - this.steeringAt > 300) this.steeringYaw = state.orientation.yawDegrees;
    const delta = angle(desiredYaw, this.steeringYaw), dt = Math.min(.15, Math.max(.01, (now - this.steeringAt) / 1000));
    if (yawMagnitude > 30) this.steeringYaw = desiredYaw;
    else if (Math.abs(delta) > 2) this.steeringYaw = normalize(this.steeringYaw + Math.sign(delta) * Math.min(Math.abs(delta), 240 * dt));
    this.steeringAt = now;
    const yawDegrees = this.steeringYaw;
    if (grounded && !this.jumpAt && Math.abs(angle(desiredYaw, state.orientation.yawDegrees)) > 10) {
      // Keep walking through gentle bends only when the actual facing direction is supported.
      const radians = state.orientation.yawDegrees * Math.PI / 180;
      const ahead = { x: p.x + Math.sin(radians) * .6, y: p.y, z: p.z + Math.cos(radians) * .6 };
      // A player turns while walking: keep going through a bend of up to 50
      // degrees as long as the ground in the current facing direction is safe.
      const forward = Math.abs(angle(desiredYaw, state.orientation.yawDegrees)) < 50 && Math.abs(next.y - p.y) < .05 &&
        map.support(ahead, w) === 9 && traverse(p, ahead, recenter);
      this.progressAt = now; return { yawDegrees, pitchDegrees: 15, forward, sneak: false, durationMs };
    }
    // Once a descending step has left its upper support, release forward and
    // let gravity settle onto the validated lower checkpoint. Continuing to hold
    // forward while airborne can carry one bounded frame past a narrow shore.
    if (!grounded && next.y < this.edgeStart.y - .05)
      return { yawDegrees, pitchDegrees: 15, forward: false, jump: false, sprint: false, sneak: false, durationMs: 180 };
    if ((next.jumpGap || next.y > p.y + .05) && grounded && !this.jumpAt) this.jumpAt = now;
    if (this.jumpAt && now - this.jumpAt > 2500) return this.replan(p, now, 'jump_failed');
    const food = state.vitals?.hunger;
    const emergency = this.evading || this.target.emergency;
    const gapSprint = next.jumpGap && horizontal(p, next) > 2.1;
    const sprint = (!!this.target.sprint || gapSprint) && grounded && (gapSprint || !this.jumpAt) && !this.landing &&
      Math.abs(next.y - p.y) < .05 && horizontal(p, next) > (this.evading || gapSprint ? .8 : 3) &&
      Math.abs(angle(desiredYaw, state.orientation.yawDegrees)) < 5 &&
      food?.max > 0 && food.current / food.max >= (emergency || gapSprint ? .1 : .6);
    return { yawDegrees, pitchDegrees: 15, forward: horizontal(p, next) > .12, durationMs,
      jump: !!this.jumpAt && now - this.jumpAt < 200, sprint,
      // Walking never crouches: a validated step down is walked off like a
      // player does, and the short frames near it bound any overshoot.
      sneak: false };
  }
}
