import { randomUUID } from 'node:crypto';
import {
  fleeTarget,
  hostileEntity,
  nearbyThreats,
  nearbyUnclearedThreats,
  threatClearDistance,
  threatStartDistance,
  threatVerticalRange,
} from '../../support/threats.ts';
import { failEdge, failedEdges } from './failed-edges.ts';
import { visitedFrontiers, visitFrontier } from './frontiers.ts';
import { clearanceRemaining, findRoute, routeRemaining } from './planner.ts';
import { angle, distance, horizontal, JUMP_HEADROOM, JUMP_HEIGHT, key, lookAt, MAX_DROP, STEP_HEIGHT } from './terrain.ts';

// Follows a route of standing cells the way a player walks: aim at the next
// cell, keep walking through bends while the head turns, jump when the next
// cell is a block up, walk off a drop, and re-plan only when the next cell
// stops being a place to stand or no progress is made for a while.
// A run of checkpoints is merged into one up to this far ahead.
// Leave a block inside the mod's eight-block input range for motion before a frame is processed.
export const MERGE_RUN = 7;
// The queued point is validated against the body's live position in the mod,
// after the previously held frame may have moved it away from the new route.
// Keep two blocks inside that eight-block boundary for request and frame lag.
const QUEUED_POINT_RANGE = 6;
// Satiety from which a walk sprints where there is room; running costs more per minute, so not on a low bar.
export const SPRINT_FOOD = 0.35;
// How often a partial route is re-planned from the body's position while walking, once the far view has filled in.
export const REPLAN_AHEAD_MS = 700;
export const NO_PROGRESS_MS = 15000;
const progressCell = p => `${Math.floor(p.x / 2)},${Math.floor(p.y / 2)},${Math.floor(p.z / 2)}`;
const sameCell = (a, b) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.z - b.z) < 0.01;
const threatMemories = new WeakMap<object, Map<string, any>>();

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
  movedAt: number;
  progressCells = new Set<string>();
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
  blocked = new Set<string>();
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
  avoidThreats: boolean;
  startSupported = false;
  // Keep the last observed threat position briefly after escaping its immediate perimeter.
  // Otherwise resuming the destination sends the body straight back into the same threat.
  rememberedThreats = new Map<string, any>();
  constructor(map, state, goal, now = Date.now(), { avoidThreats = true } = {}) {
    this.map = map;
    this.rememberedThreats = threatMemories.get(map) ?? new Map();
    threatMemories.set(map, this.rememberedThreats);
    this.blocked = failedEdges(map, now);
    this.visits = visitedFrontiers(map, now);
    this.primaryTarget = this.target = goal;
    this.avoidThreats = avoidThreats;
    this.width = state.body.halfWidth;
    this.height = state.body.height;
    this.eyeHeight = state.body.eyeHeight;
    this.startSupported = !!state.motion.onGround && !state.motion.feetInLiquid && !state.motion.swimming;
    this.deadline = now + (goal.timeoutMs ?? 60000);
    this.surveyAt = this.progressAt = now;
    this.edgeStart = state.position;
    this.movedAt = now;
    this.progressCells.add(progressCell(state.position));
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
    if (end && this.target.clearOf?.length) return clearanceRemaining(end, this.target.clearOf) === 0;
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
  restoreMerge(p) {
    if (this.mergedFrom === null) return;
    // A merged run can be extended as the body advances, leaving its original
    // first checkpoint far behind. Resume at the closest original checkpoint
    // covered by the shortcut, not blindly at that stale first checkpoint.
    let restore = this.mergedFrom;
    for (let i = restore + 1; i <= this.index; i++) if (distance(p, this.route[i]) < distance(p, this.route[restore])) restore = i;
    this.index = restore;
    this.mergedFrom = null;
    this.mergeRefused = true;
    this.edgeStart = p;
    this.bestNear = undefined;
  }
  replan(p, now, reason) {
    this.lastReplan = reason;
    if (['stalled', 'jump_failed'].includes(reason) && this.mergedFrom !== null) {
      // The failed input followed a shortcut, not the original route edge.
      // Restore the detour before excluding any of its untried steps.
      this.restoreMerge(p);
      this.progressAt = now;
      this.lastReplan = 'shortcut_stalled';
      return null;
    }
    // The edge that failed is the one into the next checkpoint; after a merge edgeStart is the
    // body's own cell, several cells short of it, which names no planner edge at all.
    if (['stalled', 'jump_failed'].includes(reason) && this.route[this.index]) {
      const edge = `${key(this.route[this.index - 1] ?? this.edgeStart)}>${key(this.route[this.index])}`;
      this.blocked.add(edge);
      failEdge(this.map, edge, now);
    }
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
    this.startSupported = !!state.motion.onGround && !wet;
    // Checkpoint arrivals and replans can both describe circling the same patch.
    // Only reaching another two-block cell renews this clock, across every route.
    const cell = progressCell(p);
    if (!this.progressCells.has(cell)) {
      this.progressCells.add(cell);
      this.movedAt = now;
    } else if (now - this.movedAt >= NO_PROGRESS_MS) return this.finish('blocked', 'no_progress');
    const from = wet ? { ...p, afloat: true } : p;
    const threats = this.avoidThreats ? (this.evading ? nearbyUnclearedThreats(state) : nearbyThreats(state)) : [];
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
    if (this.evading) {
      this.target = {
        ...this.target,
        clearOf: threats.map(entity => ({
          point: entity.point,
          minimumDistance: threatClearDistance(entity.code) + 1,
          verticalRange: threatVerticalRange(entity.code),
        })),
      };
      this.routeReaches = this.reaches(this.route.at(-1));
    }
    if (this.avoidThreats)
      for (const entity of state.nearbyEntities ?? []) {
        if (!hostileEntity(entity)) continue;
        const until = now + 60000 - (entity.ageMs ?? 0);
        if (until > now)
          this.rememberedThreats.set(entity.key, {
            point: { ...entity.point },
            minimumDistance: threatStartDistance(entity.code) + 2,
            verticalRange: threatVerticalRange(entity.code),
            until,
          });
      }
    for (const [id, entity] of this.rememberedThreats) if (entity.until <= now) this.rememberedThreats.delete(id);
    while (this.rememberedThreats.size > 128) this.rememberedThreats.delete(this.rememberedThreats.keys().next().value!);
    const activeKeys = new Set(threats.map(entity => entity.key));
    const activeAvoid = threats.map(entity => ({ point: entity.point, minimumDistance: Math.max(0, horizontal(p, entity.point) - 0.5) }));
    this.avoid = this.avoidThreats
      ? [
          ...activeAvoid,
          ...[...this.rememberedThreats.entries()]
            .filter(([id]) => !activeKeys.has(id))
            .map(([, entity]) => ({
              ...entity,
              strict: horizontal(p, entity.point) >= entity.minimumDistance,
            })),
        ]
      : [];
    if (
      grounded &&
      // A step ends on its point or just past it (within about half a block); the destination is met the same way.
      this.reaches(p)
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
      const remaining = point => routeRemaining(point, this.target);
      if (end && old && (this.reaches(end) || remaining(end) + 1.5 < remaining(old))) this.adopt(planned, p, now, true);
      else this.plannedRevision = map.revision;
    }
    // Advance past checkpoints the body has reached: close by, or crossed
    // along the segment between slow samples.
    const reached = node => {
      // A floating body sits below its swim node; on land the tolerance is a step.
      if (Math.abs(p.y - node.y) > (node.swim ? 1.5 : 0.6)) return false;
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
      if (this.routeReaches) {
        if (!this.evading) return this.finish('arrived', 'destination_reached');
        this.survey(now);
        return null;
      }
      // Remember the frontier cell this partial route ended on, by the cell's
      // own key, so the planner does not pick it again for this goal.
      const end = this.route.at(-1) ?? p,
        id = key(end);
      this.visits.set(id, (this.visits.get(id) ?? 0) + 1);
      visitFrontier(this.map, end, now);
      // A leg that needs many partial routes is not getting anywhere; give it
      // back to the caller, whose rough route and exploration can change course.
      if (++this.segments >= 10 || this.visits.get(id) > 3) return this.finish('blocked', 'exploration_exhausted');
      this.survey(now);
      return null;
    }
    // Merge a run of checkpoints the body can walk without a turn into one, gentle slopes
    // included, so bends are only where the route really turns: a route on a grid zigzags a
    // cell at a time, and a turn at every cell is a stop at every cell.
    // Momentum can carry the body away from a merged point while turning. Keep the current
    // point inside input range too, not just the point when it was first selected.
    if (this.mergedFrom !== null && distance(p, this.route[this.index]) > MERGE_RUN) {
      this.restoreMerge(p);
    }
    if (grounded && !this.mergeRefused)
      for (let ahead = this.index + 1; ahead < this.route.length; ahead++) {
        const node = this.route[ahead];
        if (distance(p, node) > MERGE_RUN) break;
        const clear = node.swim && !this.avoid.length ? map.runSwimmable(p, node) : ['walk', 'step'].includes(node.move) && map.runWalkable(p, node);
        if (!clear) break;
        // The merge is undone if the body drifts off the line it was made from (below).
        if (this.mergedFrom === null) this.mergedFrom = this.index;
        this.index = ahead;
        this.edgeStart = p;
        this.bestNear = undefined;
      }
    // Hand over a straight rise or descent before the edge. Jumps need headroom;
    // descents need a known level run beyond their landing.
    const takeoff = this.route[this.index],
      landing = this.route[this.index + 1],
      beyond = this.route[this.index + 3];
    const dropAhead =
      landing?.move === 'drop' &&
      takeoff.y - landing.y <= 2.05 &&
      beyond &&
      Math.abs(beyond.y - landing.y) < 0.05 &&
      horizontal(landing, beyond) >= 2 &&
      Math.abs(angle(lookAt(landing, beyond).yawDegrees, lookAt(takeoff, landing).yawDegrees)) < 20 &&
      map.runWalkable(landing, beyond);
    if (
      grounded &&
      (landing?.move === 'jump' || dropAhead) &&
      Math.abs(takeoff.y - p.y) < 0.1 &&
      // Hand over before the native 2.8-block sprint takeoff, allowing for the sense/frame delay.
      horizontal(p, landing) <= (state.motion.sprinting ? 3.8 : 1.8) &&
      map.runWalkable(p, takeoff)
    ) {
      const ax = takeoff.x - p.x,
        az = takeoff.z - p.z;
      const bx = landing.x - takeoff.x,
        bz = landing.z - takeoff.z;
      const length = Math.hypot(ax, az),
        nextLength = Math.hypot(bx, bz);
      const straight = length > 0.05 && (ax * bx + az * bz) / (length * nextLength) > 0.94;
      const samples = Math.max(1, Math.ceil(length * 4));
      let clear = straight;
      for (let i = 0; !dropAhead && clear && i <= samples; i++)
        clear = map.clearBetween(Math.floor(p.x + (ax * i) / samples), Math.floor(p.z + (az * i) / samples), p.y, p.y + JUMP_HEADROOM);
      if (clear) {
        this.index++;
        this.edgeStart = p;
        this.mergedFrom = null;
        this.bestNear = undefined;
      }
    }
    const next = this.route[this.index];
    this.nextCheckpoint = next;
    // Match the planner's striking-range exclusion. A safe detour can briefly get
    // closer to a threat; refusing it here replans the same route without moving.
    if (this.evading && !activeAvoid.every(item => horizontal(next, item.point) >= Math.min(3, item.minimumDistance))) {
      this.target = fleeTarget(p, threats);
      return this.replan(p, now, 'route_toward_threat');
    }
    if (
      !this.evading &&
      this.avoid.some(
        item => item.strict && Math.abs(next.y - item.point.y) <= item.verticalRange && horizontal(next, item.point) < item.minimumDistance,
      )
    )
      return this.replanNow(state, p, now, 'route_toward_threat');
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
          this.restoreMerge(p);
          this.guardHolds = 0;
          return this.tick(state, now, step);
        }
        // The route's own next cell is guarded against: the map changed under the plan; plan again.
        if (++this.guardHolds > 3) return this.replan(p, now, 'stalled');
        return { yawDegrees: desiredYaw, pitchDegrees: 15, forward: false, jump: wet, sprint: false, sneak: false, durationMs: 150 };
      }
      this.guardHolds = 0;
    }
    const last = this.index >= this.route.length - 1;
    // The cell after this one is handed over as well, so the mod rolls straight on to it when this
    // one is reached instead of pausing for a frame from here.
    const after = this.route[this.index + 1];
    // A step down of a block is walked off in stride too; only a real drop waits for the landing.
    const rollOn =
      after && (['walk', 'jump', 'step', 'swim', 'wade', undefined].includes(after.move) || (after.move === 'drop' && next.y - after.y <= 1.05));
    let next2 =
      rollOn && horizontal(p, after) <= QUEUED_POINT_RANGE && Math.abs(after.y - p.y) <= 3
        ? { x: after.x, y: after.y, z: after.z, hop: after.move === 'jump' || after.y - next.y > STEP_HEIGHT }
        : undefined;
    const food = state.vitals?.hunger;
    const emergency = this.evading || this.target.emergency;
    // A queued straight continuation is still a run, even near its intermediate point.
    let runEnd = after;
    if (after && ['walk', 'step'].includes(after.move))
      for (let i = this.index + 2; i < this.route.length; i++) {
        const candidate = this.route[i];
        if (
          !['walk', 'step'].includes(candidate.move) ||
          horizontal(next, candidate) > 4 ||
          Math.abs(angle(lookAt(next, candidate).yawDegrees, desiredYaw)) >= 20 ||
          !map.runWalkable(next, candidate)
        )
          break;
        runEnd = candidate;
      }
    // Two blocks down can be walked off in stride only with enough observed level landing
    // ground to receive the body's momentum. Otherwise the step waits for the landing.
    const drop = this.edgeStart.y - next.y;
    if (
      next.move === 'drop' &&
      drop > 1.05 &&
      (drop > 2.05 || !runEnd || horizontal(next, runEnd) < 2 || Math.abs(runEnd.y - next.y) > 0.05 || !map.runWalkable(next, runEnd))
    )
      next2 = undefined;
    const continuesRun =
      !!next2 &&
      ['walk', 'step'].includes(after.move) &&
      horizontal(p, runEnd) > 2 &&
      Math.abs(after.y - next.y) <= STEP_HEIGHT &&
      Math.abs(angle(lookAt(next, after).yawDegrees, desiredYaw)) < 20;
    const sprint =
      this.target.sprint !== false &&
      (['walk', 'step'].includes(next.move) || (continuesRun && (next.move === 'jump' || (next.move === 'drop' && drop <= 2.05)))) &&
      (near > 2 || continuesRun) &&
      (emergency || (food?.max > 0 && food.current / food.max >= SPRINT_FOOD));
    return {
      ...(next2 ? { next: next2 } : {}),
      toward: { x: next.x, y: next.y, z: next.z },
      reach: last ? Math.max(0.2, Math.min(0.35, this.target.arrivalRadius ?? 0.35)) : 0.35,
      reachY: next.swim ? 1.5 : 0.6,
      hop: jumpMove,
      yawDegrees: desiredYaw,
      pitchDegrees: 15,
      forward: true,
      // Keep swimming through surface bobs and until the body climbs onto a
      // dry bank; selecting the bank checkpoint must not release buoyancy.
      jump: (!!next.swim || (wet && !next.wet)) && state.capabilities?.includes('step_jump_hold') === true,
      sprint,
      sneak: false,
      // The hold's heartbeat caps a frame at 500 ms; the loop renews well inside that and the step carries on.
      durationMs: 500,
    };
  }
}
