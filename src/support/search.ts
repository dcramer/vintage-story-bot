import { horizontal, lookAt, normalize } from '../runtime/navigation/terrain.ts';
import { pitLimit, reachable } from './digging.ts';
import { sightRange } from './fieldwork.ts';
import { type Habitat, habitatTarget } from './habitat.ts';
import { clearLeafPath } from './leaf-clearing.ts';
import { nearestThreat, threatClearDistance } from './threats.ts';

// Looking for things, the way a player does: take what is in reach, walk to
// what is in view, go back for what was seen before, and when nothing is
// known, pick a far point in the least-walked direction and head there,
// watching the whole way. Every "find X" goal composes this loop and supplies
// only what it is looking for, how to tell it is wanted, and how to take one.
// The far point (the frontier) lives in the session's shared Places, so a goal
// restarted after a flight or a night carries on in the same direction
// instead of surveying the same patch again.

// How far a search heads when nothing is in sight. The walk rough-routes
// there in legs and looks again from each viewpoint.
export const FRONTIER_DISTANCE = 160;
// Within this of the frontier the search has arrived and chooses the next one.
export const FRONTIER_REACHED = 8;
// A near target with no route gets short local exploration legs toward it.
export const APPROACH_LEG = 24;
// Something several blocks above or below needs a wider detour to find a way up or down.
export const elevationDetour = verticalRemaining => (verticalRemaining < 1.5 ? 0 : Math.min(APPROACH_LEG, Math.max(6, verticalRemaining * 2)));
// A target overhead or in a pit costs a long climb; a slightly farther level one comes first.
export const approachScore = (position, target) => horizontal(position, target.point) + Math.abs((target.point.y ?? position.y) - position.y) * 3;
// Targets of one patch fail together: an unreachable ledge is not retried block by block.
export const samePatch = (target, candidate) =>
  horizontal(target.point, candidate.point) <= 8 && Math.abs((target.point.y ?? 0) - (candidate.point.y ?? 0)) <= 3;
export const viewChanged = (view, state) =>
  !view || horizontal(view.position, state.position) > 2 || Math.abs(normalize(state.orientation.yawDegrees - view.yawDegrees + 180) - 180) > 15;
export const stuckLeg = (result, before, after) => !['arrived', 'paused'].includes(result.state) && horizontal(before, after) <= 2;
export const unproductiveApproach = (target, result, before, after) =>
  !['arrived', 'paused'].includes(result.state) && horizontal(after, target.point) + 2 >= horizontal(before, target.point);
// A remembered thing whose approach cell was reached without seeing it again is gone or hidden.
export const exhaustedLead = (target, result, nearby = []) =>
  result.state === 'arrived' && target.visible === false && !nearby.some(object => object.key === target.key);
export const leadGuarded = (target, threat) => !!threat && horizontal(target.point, threat.point) <= threatClearDistance(threat.code);
// A frontier is given up when the predator stands the way to it: nearer than
// it and within sixty degrees of its bearing, or within its own clear distance of it.
export const frontierGuarded = (position, frontier, threat) =>
  !!threat &&
  (horizontal(frontier, threat.point) <= threatClearDistance(threat.code) ||
    (horizontal(position, threat.point) < horizontal(position, frontier) &&
      Math.abs(normalize(lookAt(position, threat.point).yawDegrees - lookAt(position, frontier).yawDegrees + 180) - 180) <= 60));

// Where to head when nothing is in sight: the compass direction whose next
// hundred blocks the bot has walked least, with turning back costing extra so
// a search keeps its line; then, if the far view holds an unwalked place of
// the kind looked for roughly that way, that place instead. Pure.
export function chooseFrontier(
  position,
  heading: number,
  {
    places,
    surface = null,
    habitats = [] as Habitat[],
    distance = FRONTIER_DISTANCE,
    avoid = [] as { x: number; z: number }[],
  }: { places: any; surface?: any; habitats?: Habitat[]; distance?: number; avoid?: { x: number; z: number }[] },
) {
  const candidates = [0, 45, -45, 90, -90, 135, -135, 180].map(offset => {
    const yaw = normalize(heading + offset),
      radians = (yaw * Math.PI) / 180;
    let cost = Math.abs(offset) / 90;
    for (let step = 16; step <= distance; step += 16) {
      const q = { x: position.x + Math.sin(radians) * step, z: position.z + Math.cos(radians) * step };
      cost += places.walked(q) + places.failed(q) * 2;
      const column = surface?.get?.(Math.floor(q.x), Math.floor(q.z));
      if (column && (column.kind === 'water' || column.kind === 'hazard')) cost += 2;
    }
    const end = { x: Math.floor(position.x + Math.sin(radians) * distance) + 0.5, z: Math.floor(position.z + Math.cos(radians) * distance) + 0.5 };
    if (avoid.some(point => horizontal(end, point) < distance / 2)) cost += 100;
    return { yaw, end, cost };
  });
  const best = candidates.sort((a, b) => a.cost - b.cost)[0];
  const place = habitatTarget(surface, position, habitats, c => places.known(c), { radius: distance, minDistance: distance / 3 });
  if (place && Math.abs(normalize(lookAt(position, place).yawDegrees - best.yaw + 180) - 180) <= 60)
    return { x: place.x, y: place.y, z: place.z, heading: best.yaw };
  const column = surface?.get?.(Math.floor(best.end.x), Math.floor(best.end.z));
  return { x: best.end.x, y: column?.y ?? position.y, z: best.end.z, heading: best.yaw };
}

export type SearchOptions = {
  // Shared frontier key: searches for the same kind of thing carry on from each other.
  kind: string;
  // Block/item code substrings the thing is known by; what memory of the view is narrowed to.
  match: string[];
  // Whether a sighting is worth taking.
  wanted: (object: any) => boolean;
  // Take one that is in reach; false when it could not be taken (it is then set aside).
  take: (object: any) => Promise<boolean>;
  // Whether a sighting can be taken from where the body stands now.
  ready?: (object: any, state: any) => boolean;
  // Among what is ready, which first.
  prefer?: (a: any, b: any) => number;
  // Cells not to stand on when approaching a target.
  approachExclude?: (target: any) => ((q: any) => boolean) | null;
  // Pages to read before judging what was seen.
  learn?: (objects: any[]) => Promise<void>;
  // Where such things are found, for the frontier choice.
  habitats?: Habitat[];
  // How far back a remembered sighting is worth walking to.
  memoryRange?: number;
  // Extra reason to pause a walk (food, threats); the search's own pauses come first.
  pauseWhen?: ((state: any) => string | null) | null;
};

// Evidence about leads lives in the places memory every goal shares: an approach that got
// nowhere marks the lead's area failed, a lead in an area failed this often is no lead for
// twenty minutes (an unreachable ledge is not retried block by block, nor by the next goal),
// and each failure makes the leads there this much farther in the ordering.
export const LEAD_FAILURES = 2;
export const FAILED_LEAD_PENALTY = 32;
// A step that moved less than this without taking or seeing anything new was unproductive.
export const PRODUCTIVE_DISTANCE = 6;
// Unproductive steps in a row before a search reports none_found to its goal.
export const SEARCH_PATIENCE = 12;

export class Search {
  field: any;
  options: SearchOptions;
  lastView: any = null;
  stuck = 0;
  // Steps in a row that took, saw or covered nothing.
  unproductive = 0;
  // The ground the body can reach from where it stands ran out: a hole, for the caller to name.
  pit = false;
  lastSeenCheck = 0;
  constructor(field, options: SearchOptions) {
    this.field = field;
    this.options = options;
  }
  get match() {
    return this.options.match;
  }
  wanted(object) {
    return this.options.wanted(object) && !this.field.skipped.has(object.key);
  }
  // Wanted things known to this goal, best first.
  targets() {
    const p = this.field.latest.position;
    const failed = o => this.field.places.failed(o.point);
    const score = o => approachScore(p, o) + failed(o) * FAILED_LEAD_PENALTY;
    return this.field
      .targets(o => this.options.wanted(o))
      .filter(o => failed(o) < LEAD_FAILURES)
      .sort((a, b) => score(a) - score(b));
  }
  ready(object) {
    return this.options.ready ? this.options.ready(object, this.field.latest) : object.withinPickingRange;
  }
  async look(radius) {
    const objects = await this.field.scan(radius, this.match, 'all');
    await this.options.learn?.(objects);
    return objects;
  }
  // A walk pauses when something looked for and not yet judged comes into view,
  // so the eye is read before the leg carries the body past it.
  pause = state => {
    const requested = this.options.pauseWhen?.(state);
    if (requested) return requested;
    // A predator in the actionable perimeter hands control back before the leg carries the body nearer.
    if (nearestThreat(state)) return 'route_threatened';
    const now = this.field.now();
    if (now - this.lastSeenCheck < 1000) return null;
    this.lastSeenCheck = now;
    return this.seenNew(state) ? 'target_seen' : null;
  };
  seenNew(state) {
    const sightings = this.field.env.sightings;
    if (!sightings || !this.field.attentive) return false;
    const p = state.position,
      eye = { ...p, y: p.y + (state.body?.eyeHeight ?? 1.6) };
    return sightings
      .view(eye, { matches: this.match, radius: sightRange, remembered: false, reach: state.pickingRange ?? 4.5 })
      .some(object => !this.field.seen.has(object.key) && !this.field.skipped.has(object.key));
  }
  // A predator seen: leads it guards are set aside, and a frontier it stands
  // between are forgotten, so the search carries on away from it.
  avoidThreat(target = null) {
    const field = this.field;
    const threat = nearestThreat(field.latest);
    const guarded = threat ? this.targets().filter(object => leadGuarded(object, threat)) : [];
    if (target && leadGuarded(target, threat) && !guarded.some(object => object.key === target.key)) guarded.push(target);
    // A lead outside the perimeter can still have its only known approach cut
    // off by the predator: it is put aside briefly so the next step considers
    // another one instead of walking into the same pause-and-evade loop.
    const skipped = guarded.length ? guarded : target ? [target] : [];
    for (const object of skipped) field.skip(object, guarded.length ? 120000 : 30000);
    field.report(guarded.length ? 'lead_threatened' : 'route_threatened', {
      target: target?.key ?? null,
      threat: threat?.code ?? null,
      skipped: skipped.map(object => object.key),
    });
    const frontier = field.places.frontier(this.options.kind);
    if (frontier && frontierGuarded(field.latest.position, frontier, threat)) field.places.clearFrontier(this.options.kind);
  }
  // One step of looking: something taken, a target approached, or ground
  // covered toward the frontier. Returns what it did.
  async step({ toward = null }: { toward?: any } = {}): Promise<'taken' | 'approached' | 'ranged'> {
    const before = { ...this.field.latest.position },
      known = new Set(this.targets().map(o => o.key));
    const did = await this.act({ toward });
    const fresh = this.targets().some(o => !known.has(o.key));
    if (did === 'taken' || fresh || horizontal(before, this.field.latest.position) > PRODUCTIVE_DISTANCE) this.unproductive = 0;
    else this.unproductive++;
    return did;
  }
  private async act({ toward = null }: { toward?: any } = {}): Promise<'taken' | 'approached' | 'ranged'> {
    const field = this.field,
      { kind, approachExclude, memoryRange = 64, habitats = ['edge', 'open'] } = this.options;
    // In reach: the surroundings pass sees all around, including behind.
    const near = await this.look(8);
    const ready = near.filter(o => this.wanted(o) && this.ready(o)).sort(this.options.prefer ?? (() => 0))[0];
    if (ready) {
      const taken = await this.options.take(ready);
      if (!taken && !field.skipped.has(ready.key)) field.skip(ready, 120000);
      return 'taken';
    }
    // In view: the forward cone, once per viewpoint; a full turn when it shows nothing; then memory.
    if (viewChanged(this.lastView, field.latest)) {
      await this.look(sightRange);
      this.lastView = { position: { ...field.latest.position }, yawDegrees: field.latest.orientation.yawDegrees };
    }
    if (!this.targets().length) {
      await this.options.learn?.(await field.lookAround(this.match, 'all'));
      this.lastView = { position: { ...field.latest.position }, yawDegrees: field.latest.orientation.yawDegrees };
    }
    if (!this.targets().length) await this.options.learn?.(field.recall(memoryRange, this.match, 'all'));
    const target = this.targets()[0];
    if (target) {
      await this.approach(target, approachExclude?.(target) ?? null);
      return 'approached';
    }
    // Nothing known: toward the frontier, choosing one when there is none or it is reached.
    let frontier = field.places.frontier(kind);
    const p = field.latest.position;
    if (!frontier || horizontal(p, frontier) <= FRONTIER_REACHED) {
      const heading = toward ? lookAt(p, toward).yawDegrees : field.heading;
      frontier = chooseFrontier(p, heading, { places: field.places, surface: field.env.surface, habitats });
      field.places.setFrontier(kind, frontier);
      field.heading = frontier.heading;
    }
    field.report('ranging', { frontier: { x: Math.round(frontier.x), z: Math.round(frontier.z) }, distance: Math.round(horizontal(p, frontier)) });
    let result = await field.walk({ x: frontier.x, y: frontier.y, z: frontier.z, horizontalOnly: true, arrivalRadius: 4 }, this.pause);
    // The far view shows no way there (under trees, in a dip): walk a short leg that way on what
    // memory knows and look again from there, the way a player walks on through a wood. Standing
    // still choosing frontiers is not looking.
    if (result.state === 'blocked' && result.reason === 'no_visible_route') {
      const leg = field.explore(frontier, APPROACH_LEG);
      if (leg) result = await field.walk(leg, this.pause);
      else await field.wait(1000);
    }
    if (this.inPit(result)) return 'ranged';
    if (result.state === 'paused' && result.reason === 'route_threatened') this.avoidThreat();
    if (stuckLeg(result, p, field.latest.position)) {
      // Stopped short: turn first; stuck again on the same spot, cut through the leaves.
      field.places.clearFrontier(kind);
      if (this.stuck++ >= 1 && (await clearLeafPath(field, frontier))) this.stuck = 0;
      else field.resetExploration(90);
    } else this.stuck = 0;
    if (['arrived', 'paused'].includes(result.state) || horizontal(p, field.latest.position) > 2) this.lastView = null;
    return 'ranged';
  }
  // A walk that found no route at all from a spot with hardly any ground to reach: the body is in a
  // hole, and no search gets it out. The goal ends with reason pit for the brain to dig out, as travel does.
  inPit(result) {
    if (result?.state !== 'blocked' || result.reason !== 'no_observed_route') return false;
    const map = this.field.env?.map,
      p = this.field.latest.position;
    const here = map?.nodeAt?.(Math.floor(p.x), Math.floor(p.z), p.y, 0.6, 0.6);
    if (!here || reachable(map, here) >= pitLimit) return false;
    this.pit = true;
    this.field.report('pit', { position: p });
    return true;
  }
  // Nothing taken, seen or covered for a while: the goal gives up here. Where it stood is marked
  // failed and the frontier dropped, so the next search of this kind heads somewhere else.
  exhausted() {
    if (this.unproductive < SEARCH_PATIENCE) return false;
    this.field.places.fail(this.field.latest.position);
    this.field.places.clearFrontier(this.options.kind);
    this.field.report('exhausted', { unproductive: this.unproductive });
    return true;
  }
  async approach(target, exclude) {
    const field = this.field;
    const before = { ...field.latest.position };
    const destination = field.approach(target, exclude);
    if (destination) {
      const result = await field.walk(destination, this.pause);
      if (this.inPit(result)) return;
      // A leg that paused (a new lead in view, a bite, a threat) is not a leg that got nowhere.
      if (!['arrived', 'paused'].includes(result.state)) field.places.fail(target.point);
      // The far eye is directional: reaching an old lead, read the surroundings
      // all around before calling the thing gone.
      const nearby = result.state === 'arrived' && target.visible === false ? await this.look(8) : [];
      if (exhaustedLead(target, result, nearby)) {
        // Blocks are remembered for days; one that is not there when its cell
        // is looked at from beside it is forgotten, not walked to again.
        field.skip(target, 120000);
        field.seen.delete(target.key);
        field.env.sightings?.forget?.(target.key);
        field.report('lead_unseen', { target: target.key });
      } else if (result.state === 'paused' && result.reason === 'route_threatened') {
        this.avoidThreat(target);
      } else if (result.state === 'arrived' && target.kind === 'item') {
        // Walked over: picked up natively, or not to be had from here.
        field.skip(target, 15000);
      } else if (stuckLeg(result, before, field.latest.position) || unproductiveApproach(target, result, before, field.latest.position)) {
        const elevated = Math.abs((target.point.y ?? before.y) - before.y) > 2;
        for (const object of elevated ? this.targets().filter(candidate => samePatch(target, candidate)) : [target]) field.skip(object, 120000);
        await clearLeafPath(field, target.point);
      }
      return;
    }
    const detour = elevationDetour(Math.abs(field.latest.position.y - target.point.y));
    if (horizontal(field.latest.position, target.point) > 6 || detour) {
      const result = await field.walk(field.explore(target.point, APPROACH_LEG, detour), this.pause);
      if (this.inPit(result)) return;
      const nearer = horizontal(field.latest.position, target.point) + 2 < horizontal(before, target.point);
      if (!['arrived', 'paused'].includes(result.state) && !nearer) field.places.fail(target.point);
      if (result.state === 'paused' && result.reason === 'route_threatened') this.avoidThreat(target);
      else if (stuckLeg(result, before, field.latest.position)) {
        const elevated = Math.abs((target.point.y ?? before.y) - before.y) > 2;
        for (const object of elevated ? this.targets().filter(candidate => samePatch(target, candidate)) : [target]) field.skip(object, 120000);
        await clearLeafPath(field, target.point);
      }
      return;
    }
    field.skip(target, 30000);
  }
}
