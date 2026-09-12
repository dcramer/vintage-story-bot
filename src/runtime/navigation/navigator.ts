import { randomUUID } from 'node:crypto';
import { fleeTarget, nearbyThreats, nearbyUnclearedThreats } from '../../support/threats.ts';
import { findRoute } from './planner.ts';
import { angle, horizontal, JUMP_HEIGHT, key, lookAt, MAX_DROP, STEP_HEIGHT } from './terrain.ts';

// Follows a route of standing cells the way a player walks: aim at the next
// cell, keep walking through bends while the head turns, jump when the next
// cell is a block up, walk off a drop, and re-plan only when the next cell
// stops being a place to stand or no progress is made for a while.
// A run of checkpoints is merged into one up to this far ahead.
export const MERGE_RUN = 8;
// Satiety from which a walk sprints where there is room; running costs more per minute, so not on a low bar.
export const SPRINT_FOOD = 0.35;
// How often a partial route is re-planned from the body's position while walking, once the far view has filled in.
export const REPLAN_AHEAD_MS = 700;
const sameCell = (a, b) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.z - b.z) < 0.01;

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
  // The route index a straight-run merge started from, while one is in effect.
  mergedFrom: number | null = null;
  // After a refused shortcut, follow the original checkpoint before trying another merge.
  mergeRefused = false;
  routeReaches = false;
  guardHolds = 0;
  jumpAt = 0;
  airborne = false;
  nextPlanAt = 0;
  plannedRevision = 0;
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
  // Whether a route's last cell satisfies the destination (a full route) or is only the nearest frontier.
  reaches(end) {
    return (
      !!end &&
      horizontal(end, this.target) <= Math.max(this.target.arrivalRadius ?? 0.3, 0.5) + 0.01 &&
      (this.target.horizontalOnly || Math.abs(end.y - this.target.y) < 0.6)
    );
  }
  // Take a route in hand from where the body stands: fresh from a survey, or in stride while walking
  // (then the progress clock keeps running, so a body that is not getting anywhere still stalls).
  adopt(planned, p, now, stride = false) {
    this.route = planned;
    this.index = 0;
    this.state = 'moving';
    this.routeReaches = this.reaches(planned.at(-1));
    this.plannedRevision = this.map.revision;
    this.edgeStart = p;
    this.bestNear = undefined;
    this.mergedFrom = null;
    this.mergeRefused = false;
    this.guardHolds = 0;
    if (!stride) this.progressAt = now;
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
    // The edge that failed is the one into the next checkpoint; after a merge edgeStart is the
    // body's own cell, several cells short of it, which names no planner edge at all.
    if (['stalled', 'jump_failed'].includes(reason) && this.route[this.index])
      this.blocked.add(`${key(this.route[this.index - 1] ?? this.edgeStart)}>${key(this.route[this.index])}`);
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
    return this.tick(state, now, null);
  }
  tick(state, now = Date.now(), step: any = null) {
    if (!this.active) return null;
    if (now >= this.deadline) return this.finish('blocked', 'deadline');
    // Standing in water counts as support: wading and swimming move on from there.
    const p = state.position,
      grounded = state.motion.onGround || !!state.motion.feetInLiquid || !!state.motion.swimming,
      map = this.map,
      w = this.width,
      h = this.height;
    // In water the jump key keeps the head up; a body that stops holding it sinks and drowns.
    const wet = !!(state.motion.feetInLiquid || state.motion.swimming);
    const from = wet ? { ...p, afloat: true } : p;
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
      // A step ends on its point or just past it (within about half a block); the destination is met the same way.
      horizontal(p, this.target) < Math.max(this.target.arrivalRadius ?? 0.3, 0.5) &&
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
        planned = findRoute(map, from, this.target, w, h, this);
      }
      if (!planned) {
        if (now - this.surveyAt < 2500) {
          this.lookingAt = [...map.views(p).values()].sort((a, b) => horizontal(a, this.target) - horizontal(b, this.target))[0] ?? null;
          return { yawDegrees: lookAt(p, this.target).yawDegrees, pitchDegrees: 15, focus: this.lookingAt, jump: wet };
        }
        planned = findRoute(map, from, this.target, w, h, this);
      }
      if (!planned) {
        this.diagnostics = { missing: [...map.views(p).values()].slice(0, 24), standing: map.standingOn(p) };
        return this.finish('blocked', 'no_observed_route');
      }
      this.adopt(planned, p, now);
      this.lookingAt = null;
    }
    // Planning ahead while walking: a partial route ends where the eye had seen to when it was planned,
    // and the far view keeps filling in as the body moves. When it has, plan again from where the body
    // is and take the new route in stride if it gets farther, so the walk changes course without a
    // stop at the old frontier and the survey there never happens.
    if (grounded && !this.routeReaches && now >= this.nextPlanAt && map.revision !== this.plannedRevision) {
      this.nextPlanAt = now + REPLAN_AHEAD_MS;
      const planned = findRoute(map, from, this.target, w, h, this);
      const end = planned?.at(-1),
        old = this.route.at(-1);
      if (end && old && (this.reaches(end) || horizontal(end, this.target) + 1.5 < horizontal(old, this.target))) this.adopt(planned, p, now, true);
      else this.plannedRevision = map.revision;
    }
    // Advance past checkpoints the body has reached: close by, or crossed
    // along the segment between slow samples.
    const reached = node => {
      // A floating body sits below its swim node; on land the tolerance is a step.
      if (Math.abs(p.y - node.y) > (node.swim || state.motion.swimming ? 1.5 : 0.6)) return false;
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
    // The mod reports the point it last reached; it may already be rolling on to the one after.
    const arrivedAt = step?.arrived ?? (step?.state === 'arrived' ? step.toward : null);
    while (this.index < this.route.length && (reached(this.route[this.index]) || (arrivedAt && sameCell(arrivedAt, this.route[this.index])))) {
      this.edgeStart = this.route[this.index++];
      this.progressAt = now;
      this.bestNear = undefined;
      this.mergedFrom = null;
      this.mergeRefused = false;
    }
    if (this.index >= this.route.length) {
      // The last cell of a full route was reached: the body stands within a step's tolerance of the
      // destination, which is as close as a walk gets to any point; that is arrival.
      if (this.routeReaches) return this.finish('arrived', 'destination_reached');
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
    // Merge a run of checkpoints the body can walk without a turn into one, gentle slopes
    // included, so bends are only where the route really turns: a route on a grid zigzags a
    // cell at a time, and a turn at every cell is a stop at every cell.
    if (grounded && !this.mergeRefused)
      for (let ahead = this.index + 1; ahead < this.route.length; ahead++) {
        const node = this.route[ahead];
        if (!['walk', 'step'].includes(node.move) || horizontal(p, node) > MERGE_RUN || !map.runWalkable(p, node)) break;
        // The merge is undone if the body drifts off the line it was made from (below).
        if (this.mergedFrom === null) this.mergedFrom = this.index;
        this.index = ahead;
        this.edgeStart = p;
        this.bestNear = undefined;
      }
    const next = this.route[this.index];
    this.nextCheckpoint = next;
    // A route that leads back toward a threat is replanned like any other failure, so the
    // replan cap ends the walk instead of the same route being refused every tick.
    if (this.evading && !this.avoid.every(item => horizontal(next, item.point) >= item.minimumDistance)) {
      this.target = fleeTarget(p, threats);
      return this.replan(p, now, 'route_toward_threat');
    }
    // The next cell must still be a place to stand.
    // A swim node sits half a block under the surface; a dry one is exact.
    const still = map.nodeAt(Math.floor(next.x), Math.floor(next.z), next.y, next.swim ? 1 : 0.1, next.swim ? 1 : 0.1);
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
    // The mod walks each step with its hand on the keys every tick and says how it went:
    // blocked on this very point is a replan now, not after three seconds of hoping.
    if (step?.state === 'blocked' && sameCell(step.toward, next)) return this.replan(p, now, 'stalled');
    if (now - this.progressAt > 4000) return this.replan(p, now, 'stalled');
    // A hop is what the route says or what the body sees from where it stands; mid-air the
    // body's own height says nothing, so the last checkpoint's does.
    const rise = next.y - (grounded ? p.y : this.edgeStart.y);
    const jumpMove = next.move === 'gap' || next.move === 'jump' || rise > STEP_HEIGHT;
    // Cliff guard: never step toward a cell that has nothing to stand on within a jump up or
    // three blocks down, unless it is the checkpoint itself. A merged run whose straight line
    // no longer fits from here goes back to the route's own cells, which are known to stand.
    if (grounded && !wet) {
      const radians = (desiredYaw * Math.PI) / 180;
      const fx = Math.floor(p.x + Math.sin(radians) * 0.7),
        fz = Math.floor(p.z + Math.cos(radians) * 0.7);
      const own = fx === Math.floor(p.x) && fz === Math.floor(p.z),
        checkpoint = fx === Math.floor(next.x) && fz === Math.floor(next.z);
      if (!own && !checkpoint && !map.levels(fx, fz, p.y, JUMP_HEIGHT, MAX_DROP).length) {
        if (this.mergedFrom !== null && this.mergedFrom < this.index) {
          // Back to the route's own cells; the progress clock keeps running, so a guard that
          // trips every tick still ends in a replan instead of a body standing for minutes.
          this.mergeRefused = true;
          this.index = this.mergedFrom;
          this.mergedFrom = null;
          this.edgeStart = p;
          this.bestNear = undefined;
          this.guardHolds = 0;
          return this.tick(state, now, step);
        }
        // The route's own next cell is guarded against: the map changed under the plan; plan again.
        if (++this.guardHolds > 3) return this.replan(p, now, 'stalled');
        return { yawDegrees: desiredYaw, pitchDegrees: 15, forward: false, jump: wet, sprint: false, sneak: false, durationMs: 150 };
      }
      this.guardHolds = 0;
    }
    const food = state.vitals?.hunger;
    const emergency = this.evading || this.target.emergency;
    // Running from something is done at a sprint whatever the stomach says; otherwise when the stomach
    // allows and there is a run ahead worth it. A goal may forbid it (sprint: false).
    const sprint =
      this.target.sprint !== false && next.move === 'walk' && near > 2 && (emergency || (food?.max > 0 && food.current / food.max >= SPRINT_FOOD));
    const last = this.index >= this.route.length - 1;
    // The cell after this one is handed over as well, so the mod rolls straight on to it when this
    // one is reached instead of pausing for a frame from here.
    const after = this.route[this.index + 1];
    // A step down of a block is walked off in stride too; only a real drop waits for the landing.
    const rollOn = after && (['walk', 'jump', 'step', undefined].includes(after.move) || (after.move === 'drop' && next.y - after.y <= 1.05));
    const next2 =
      rollOn && horizontal(p, after) <= 7.4 && Math.abs(after.y - p.y) <= 3
        ? { x: after.x, y: after.y, z: after.z, hop: after.move === 'jump' || after.y - next.y > STEP_HEIGHT }
        : undefined;
    return {
      ...(next2 ? { next: next2 } : {}),
      toward: { x: next.x, y: next.y, z: next.z },
      reach: last ? Math.max(0.2, Math.min(0.35, this.target.arrivalRadius ?? 0.35)) : 0.35,
      reachY: next.swim || wet ? 1.5 : 0.6,
      hop: jumpMove,
      yawDegrees: desiredYaw,
      pitchDegrees: 15,
      forward: true,
      jump: false,
      sprint,
      sneak: false,
      // The hold's heartbeat caps a frame at 500 ms; the loop renews well inside that and the step carries on.
      durationMs: 500,
    };
  }
}
