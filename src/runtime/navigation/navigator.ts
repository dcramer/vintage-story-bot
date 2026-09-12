import { randomUUID } from 'node:crypto';
import { fleeTarget, nearbyThreats, nearbyUnclearedThreats } from '../../support/threats.ts';
import { findRoute } from './planner.ts';
import { angle, horizontal, JUMP_HEIGHT, key, lookAt, MAX_DROP, normalize, STEP_HEIGHT } from './terrain.ts';

// Follows a route of standing cells the way a player walks: aim at the next
// cell, keep walking through bends while the head turns, jump when the next
// cell is a block up, walk off a drop, and re-plan only when the next cell
// stops being a place to stand or no progress is made for a while.
export class Navigation {
  bestNear: any;
  deadline: any;
  desiredYaw: any;
  diagnostics: any;
  edgeStart: any;
  eyeHeight: any;
  height: any;
  lastReplan: any;
  map: any;
  nextCheckpoint: any;
  primaryTarget: any;
  progressAt: any;
  replannedAt: any;
  steppedOff: any;
  surveyAt: any;
  target: any;
  width: any;
  yawError: any;
  id = randomUUID();
  state = 'surveying';
  reason = null;
  events: any[] = [];
  route = [];
  index = 0;
  replans = 0;
  segments = 0;
  blocked = new Set();
  visits = new Map();
  lookingAt = null;
  jumpAt = 0;
  airborne = false;
  nextPlanAt = 0;
  steeringYaw = null;
  steeringAt = 0;
  evading = false;
  threat = null;
  threats = [];
  avoid = [];
  constructor(map, state, goal, now = Date.now()) {
    this.map = map;
    this.primaryTarget = this.target = goal;
    this.width = state.body.halfWidth;
    this.height = state.body.height;
    this.eyeHeight = state.body.eyeHeight;
    this.deadline = now + (goal.timeoutMs ?? 60000);
    this.surveyAt = this.progressAt = now;
    this.edgeStart = state.position;
  }
  get active() {
    return ['surveying', 'moving'].includes(this.state);
  }
  observe() {
    return {
      id: this.id,
      state: this.state,
      reason: this.reason,
      target: this.target,
      remainingCheckpoints: Math.max(0, this.route.length - this.index),
      replans: this.replans,
      segments: this.segments,
      cachedCells: this.map.cells.size,
      lookingAt: this.lookingAt,
      nextCheckpoint: this.nextCheckpoint,
      desiredYaw: this.desiredYaw,
      yawError: this.yawError,
      lastReplan: this.lastReplan,
      diagnostics: this.diagnostics,
      evading: this.evading,
      threat: this.threat,
      threats: this.threats,
      events: this.events ?? [],
    };
  }
  finish(state, reason) {
    this.state = state;
    this.reason = reason;
    this.lookingAt = null;
    return null;
  }
  survey(now) {
    this.state = 'surveying';
    this.surveyAt = now;
    this.jumpAt = 0;
    this.airborne = false;
    this.lookingAt = null;
    this.nextPlanAt = 0;
  }
  replan(_p, now, reason) {
    this.lastReplan = reason;
    if (['stalled', 'jump_failed'].includes(reason) && this.route[this.index])
      this.blocked.add(`${key(this.edgeStart)}>${key(this.route[this.index])}`);
    if (++this.replans > 12) return this.finish('blocked', reason);
    this.survey(now);
    this.bestNear = undefined;
    this.progressAt = now;
    return null;
  }
  // Re-plan in this same tick so a changed cell costs no stopped frame, but
  // only once per tick so a route failing the same check cannot recurse.
  replanNow(state, p, now, reason) {
    this.replan(p, now, reason);
    if (!this.active || this.replannedAt === now) return null;
    this.replannedAt = now;
    return this.tick(state, now);
  }
  tick(state, now = Date.now()) {
    if (!this.active) return null;
    if (now >= this.deadline) return this.finish('blocked', 'deadline');
    // Standing in water counts as support: wading and swimming move on from there.
    const p = state.position,
      grounded = state.motion.onGround || !!state.motion.feetInLiquid || !!state.motion.swimming,
      map = this.map,
      w = this.width,
      h = this.height;
    const threats = this.evading ? nearbyUnclearedThreats(state) : nearbyThreats(state);
    const nearby = threats[0] ?? null;
    if (!this.evading && nearby) {
      this.evading = true;
      this.threat = nearby;
      this.threats = threats;
      this.target = fleeTarget(p, threats);
      this.survey(now);
    } else if (this.evading && !nearby) {
      this.evading = false;
      this.threat = null;
      this.threats = [];
      this.avoid = [];
      this.target = this.primaryTarget;
      this.survey(now);
    } else if (this.evading) {
      this.threat = nearby;
      this.threats = threats;
    }
    this.avoid = threats.map(entity => ({ point: entity.point, minimumDistance: Math.max(0, horizontal(p, entity.point) - 0.5) }));
    if (
      grounded &&
      horizontal(p, this.target) < (this.target.arrivalRadius ?? 0.3) &&
      (this.target.horizontalOnly || Math.abs(p.y - this.target.y) < 0.6)
    ) {
      if (this.evading && nearby) {
        this.threat = nearby;
        this.target = fleeTarget(p, threats);
        this.survey(now);
      } else return this.finish('arrived', 'destination_reached');
    }
    if (this.state === 'surveying') {
      if (!grounded) return now - this.surveyAt > 1500 ? this.finish('blocked', 'lost_support') : null;
      let planned = null;
      if (now >= this.nextPlanAt) {
        this.nextPlanAt = now + 300;
        planned = findRoute(map, p, this.target, w, h, this);
      }
      if (!planned) {
        if (now - this.surveyAt < 2500) {
          this.lookingAt = [...map.views(p).values()].sort((a, b) => horizontal(a, this.target) - horizontal(b, this.target))[0] ?? null;
          return { yawDegrees: lookAt(p, this.target).yawDegrees, pitchDegrees: 15, focus: this.lookingAt };
        }
        planned = findRoute(map, p, this.target, w, h, this);
      }
      if (!planned) {
        this.diagnostics = { missing: [...map.views(p).values()].slice(0, 24), standing: map.standingOn(p) };
        return this.finish('blocked', 'no_observed_route');
      }
      this.route = planned;
      this.index = 0;
      this.state = 'moving';
      this.lookingAt = null;
      this.edgeStart = p;
      this.bestNear = undefined;
      this.progressAt = now;
    }
    // Advance past checkpoints the body has reached: close by, or crossed
    // along the segment between slow samples.
    const reached = node => {
      if (Math.abs(p.y - node.y) > 0.6) return false;
      // A cell reached by dropping counts only once the body has landed on it.
      if (node.y < this.edgeStart.y - STEP_HEIGHT) return grounded && horizontal(p, node) < 0.5;
      if (horizontal(p, node) < 0.4) return true;
      const dx = node.x - this.edgeStart.x,
        dz = node.z - this.edgeStart.z,
        length = Math.hypot(dx, dz);
      if (length < 0.01) return false;
      const along = ((p.x - node.x) * dx + (p.z - node.z) * dz) / length;
      const lateral = Math.abs((p.x - node.x) * dz - (p.z - node.z) * dx) / length;
      return along >= 0 && along < 2.5 && lateral < 0.5 && Math.abs(p.y - node.y) < 0.6;
    };
    while (this.index < this.route.length && reached(this.route[this.index])) {
      this.edgeStart = this.route[this.index++];
      this.jumpAt = 0;
      this.airborne = false;
      this.progressAt = now;
      this.bestNear = undefined;
    }
    if (this.index >= this.route.length) {
      // Remember the frontier cell this partial route ended on, by the cell's
      // own key, so the planner does not pick it again for this goal.
      const end = this.route.at(-1) ?? p,
        id = key(end);
      this.visits.set(id, (this.visits.get(id) ?? 0) + 1);
      // A leg that needs many partial routes is not getting anywhere; give it
      // back to the caller, whose rough route and exploration can change course.
      if (++this.segments >= 10 || this.visits.get(id) > 3) return this.finish('blocked', 'exploration_exhausted');
      this.survey(now);
      return null;
    }
    // Merge a straight, level run of checkpoints into one so bends are only
    // where the route really turns.
    if (grounded && !this.jumpAt)
      for (let ahead = this.index + 1; ahead < this.route.length; ahead++) {
        const node = this.route[ahead];
        if (
          node.move !== 'walk' ||
          horizontal(p, node) > 4 ||
          Math.abs(node.y - p.y) > 0.05 ||
          !map.lineWalkable({ x: p.x, y: node.y, z: p.z }, node)
        )
          break;
        this.index = ahead;
        this.edgeStart = p;
        this.bestNear = undefined;
      }
    const next = this.route[this.index];
    this.nextCheckpoint = next;
    if (this.evading && !this.avoid.every(item => horizontal(next, item.point) >= item.minimumDistance)) {
      this.target = fleeTarget(p, threats);
      this.survey(now);
      return null;
    }
    // The next cell must still be a place to stand.
    const still = map.nodeAt(Math.floor(next.x), Math.floor(next.z), next.y, 0.1, 0.1);
    if (!still) {
      this.diagnostics = { kind: 'checkpoint_gone', point: next };
      return grounded ? this.replanNow(state, p, now, 'terrain_changed') : this.finish('blocked', 'landing_changed');
    }
    // Progress is getting closer to the checkpoint; sliding along a block
    // face or jittering in place is not.
    const near = horizontal(p, next);
    if (this.bestNear === undefined || this.bestNear - near > 0.1) {
      this.bestNear = near;
      this.progressAt = now;
    }
    const desiredYaw = lookAt(p, next).yawDegrees;
    this.desiredYaw = desiredYaw;
    this.yawError = angle(desiredYaw, state.orientation.yawDegrees);
    const yawMagnitude = Math.abs(this.yawError);
    if (now - this.progressAt > 3000) return this.replan(p, now, 'stalled');
    // Steering: snap large turns, ease small ones, and sample often while turning.
    if (this.steeringYaw === null || now - this.steeringAt > 300) this.steeringYaw = state.orientation.yawDegrees;
    const delta = angle(desiredYaw, this.steeringYaw),
      dt = Math.min(0.15, Math.max(0.01, (now - this.steeringAt) / 1000));
    if (yawMagnitude > 30) this.steeringYaw = desiredYaw;
    else if (Math.abs(delta) > 2) this.steeringYaw = normalize(this.steeringYaw + Math.sign(delta) * Math.min(Math.abs(delta), 240 * dt));
    this.steeringAt = now;
    const yawDegrees = this.steeringYaw;
    const following = this.route[this.index + 1];
    const turn = following ? Math.abs(angle(lookAt(next, following).yawDegrees, desiredYaw)) : 0;
    // What the next cell asks of the body is decided from where the body
    // is now, not from the cell the plan came from: a cell a block up is a
    // jump even if the route reached it on the level.
    const rise = next.y - p.y;
    const jumpMove = next.move === 'gap' || rise > STEP_HEIGHT;
    const dropping = rise < -STEP_HEIGHT;
    const tight = near < 2 && (jumpMove || dropping || turn > 60);
    const durationMs = dropping && near < 1.2 ? 120 : tight || yawMagnitude > 30 ? 180 : 500;
    // Jumps go straight at the cell from close by; everything else keeps
    // walking through the bend while the head comes round.
    if (jumpMove && grounded && !this.jumpAt && yawMagnitude < 15 && near < (next.move === 'gap' ? 2.2 : 1.3)) this.jumpAt = now;
    if (this.jumpAt && !grounded) this.airborne = true;
    if (this.jumpAt && now - this.jumpAt > 2500) return this.replan(p, now, 'jump_failed');
    let walking = jumpMove && near < 1.3 && !this.jumpAt ? yawMagnitude < 15 : yawMagnitude < 60 || (durationMs === 180 && yawMagnitude <= 90);
    // A drop is walked to the edge, then left with one short step so the
    // body lands on the cell below instead of flying past it. Walking pace
    // off an edge carries about two blocks before a three-block fall lands.
    if (dropping && near < 1.2) {
      if (yawMagnitude > 20) walking = false;
      else if (near > 0.62) walking = true;
      else if (this.steppedOff !== next) {
        this.steppedOff = next;
        walking = true;
      } else walking = false;
    }
    // Cliff guard: never walk toward a cell that has nothing to stand on
    // within a jump up or three blocks down, unless it is the checkpoint
    // itself. Turning brings the facing back onto the route first.
    if (walking && grounded && !this.jumpAt) {
      const radians = (state.orientation.yawDegrees * Math.PI) / 180;
      const fx = Math.floor(p.x + Math.sin(radians) * 0.7),
        fz = Math.floor(p.z + Math.cos(radians) * 0.7);
      const own = fx === Math.floor(p.x) && fz === Math.floor(p.z),
        checkpoint = fx === Math.floor(next.x) && fz === Math.floor(next.z);
      if (!own && !checkpoint && !map.levels(fx, fz, p.y, JUMP_HEIGHT, MAX_DROP).length) walking = false;
    }
    // Falling: let gravity land the body on the validated lower cell.
    if (!grounded && !this.jumpAt) return { yawDegrees, pitchDegrees: 15, forward: false, jump: false, sprint: false, sneak: false, durationMs: 120 };
    // In water the jump key keeps the head up and climbs the bank; never sneak there.
    const wet = !!(state.motion.feetInLiquid || state.motion.swimming);
    const food = state.vitals?.hunger;
    const emergency = this.evading || this.target.emergency;
    const straight = turn < 5 && next.move === 'walk' && near > 3 && yawMagnitude < 5;
    const sprint =
      !!this.target.sprint && grounded && !this.jumpAt && straight && food?.max > 0 && food.current / food.max >= (emergency ? 0.1 : 0.6);
    return {
      yawDegrees,
      pitchDegrees: 15,
      forward: walking && near > 0.12,
      durationMs,
      jump: wet || (!!this.jumpAt && now - this.jumpAt < 200),
      sprint,
      sneak: false,
    };
  }
}
