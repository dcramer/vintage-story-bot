import { horizontal } from '../navigation/terrain.mjs';
import { temporalStormUnsafe } from './fieldwork.mjs';
import { nearestThreat } from './threats.mjs';
import { clearLeafPath } from './leaf-clearing.mjs';

export const routeRegressed = (best, current, margin = 12) => current > best + margin;
export const elevationDetourDistance = verticalRemaining => verticalRemaining < 1.5 ? 0 :
  Math.min(24, Math.max(12, verticalRemaining * 2));

const guardStorm = state => {
  if (temporalStormUnsafe(state)) throw Error('Temporal storm active or imminent; travel postponed.');
};

// Chain bounded navigation legs toward a far destination; exploration legs detour around unknown terrain.
export async function travel(field, survival, { x, y, z, arrivalRadius = 1 }) {
  let stuck = 0, legs = 0, routeResets = 0, resetsWithoutProgress = 0, continuation = null, localDetour = false;
  let bestRemaining = Infinity;
  const summary = () => ({ moved: +field.moved.toFixed(1), legs, stuck, routeResets });
  while (true) {
    let state = await field.observe(true);
    guardStorm(state);
    let goal = { x, y: y ?? state.position.y, z };
    const beforeFood = state.position;
    await survival?.tend({ toward: goal });
    // Food recovery may travel a meaningful distance and elevation. Resume
    // from its verified final observation rather than planning from stale state.
    state = field.latest;
    goal = { x, y: y ?? state.position.y, z };
    const remaining = horizontal(state.position, goal);
    if (horizontal(beforeFood, state.position) > 2) bestRemaining = remaining;
    else bestRemaining = Math.min(bestRemaining, remaining);
    if (remaining <= arrivalRadius && (y === undefined || Math.abs(state.position.y - y) < 1.5))
      return { ok: true, goal: 'travel', ...summary(), remaining: +remaining.toFixed(1), position: state.position };
    field.report('travelling', { remaining: +remaining.toFixed(1), legs, roughRoute: field.roughRouteStatus });
    const elevationDetour = y === undefined ? 0 : elevationDetourDistance(Math.abs(state.position.y - y));
    // walk looks at the landscape and follows rough routes on its own; legs here
    // only choose the destination, and exploration legs remain the fallback
    // once nothing visible leads toward it.
    const leg = remaining <= 48 && !localDetour
      ? (y === undefined ? { x, y: state.position.y, z, horizontalOnly: true, arrivalRadius } : { x, y, z, arrivalRadius })
      : continuation ?? field.explore(goal, Math.min(48, Math.max(remaining, elevationDetour)), elevationDetour);
    const before = state.position;
    const result = await field.walk(leg, current => {
      if (temporalStormUnsafe(current)) return 'temporal_storm';
      const survivalReason = survival?.pauseWhen(current);
      if (survivalReason) return survivalReason;
      const currentRemaining = horizontal(current.position, goal);
      bestRemaining = Math.min(bestRemaining, currentRemaining);
      return !nearestThreat(current) && routeRegressed(bestRemaining, currentRemaining) ? 'route_regressed' : null;
    });
    guardStorm(field.latest);
    legs++;
    const progress = horizontal(before, field.latest.position);
    // A partial frontier can end a valid leg after moving only partway around
    // a large ridge or forest barrier. Keep extending that same detour while
    // each fresh terrain cache makes real progress; changing compass targets
    // immediately sends the bot back across the cells it just traversed.
    continuation = !['arrived', 'paused'].includes(result.state) && progress > 2 ? leg : null;
    if (result.reason === 'route_regressed') {
      continuation = null;
      field.penalize(leg);
      // The regression budget belongs to one route attempt. Once that route
      // pauses, its verified recovery position becomes the next attempt's
      // baseline; retaining the older best makes every replacement route
      // pause on its first observation without taking a step.
      bestRemaining = horizontal(field.latest.position, goal);
    }
    // A nearby destination can still sit behind a dense tree line, ridge or
    // cliff. After one stationary direct attempt, use the same deterministic
    // forward/lateral frontier search as long travel instead of retrying an
    // identical unobserved segment forever.
    localDetour = remaining <= 48 && !['arrived', 'paused'].includes(result.state) && progress <= 2;
    if (result.state === 'arrived' || result.state === 'paused' || progress > 2) { stuck = 0; resetsWithoutProgress = 0; }
    else {
      stuck++;
      // The planner has already exhausted non-mutating routes for this leg.
      // Clear an explicitly observed leaf now; waiting through two identical
      // 20-second surveys wastes the food window in dense forest. Keep the
      // less constrained physical nudge behind the established stuck count.
      // Exploration targets are disposable probes around hard terrain. Do not
      // cut permanent openings toward a sideways or reverse probe: in dense
      // forest that clears random canopy while moving away from the trip. Aim
      // leaf clearing at the actual destination; non-mutating routes may still
      // detour around cliffs, water and other hard obstacles.
      const cleared = await clearLeafPath(field, goal);
      // Enter the gap we just verified and opened. Without this bounded
      // sneaking probe, a dense canopy can make the planner return to the same
      // pre-clearing cell and spend the whole day carving without advancing.
      const nudged = cleared ? await field.nudge(goal) : stuck >= 3 ? await field.nudge(leg) : 0;
      if (cleared || nudged > .1) {
        // Once a cautious probe proves this opening is physically
        // traversable, retry it after one planner failure instead of
        // waiting through three identical surveys for every half block.
        stuck = nudged > .1 ? 2 : 0;
        continuation = null;
        localDetour = false;
        field.report('route_cleared', { remaining: +horizontal(field.latest.position, goal).toFixed(1), legs });
        continue;
      }
      if (stuck < 6) continue;
      // A long trip can exhaust every local alternative on a steep ridge even
      // though a fresh per-goal visit history immediately finds a route. Reset
      // only that soft penalty and rotate the deterministic search; observed
      // terrain, skipped resources and the task deadline remain intact.
      routeResets++;
      // Four reset cycles with no net progress means this destination is not
      // reachable from here with what can be observed. Report blocked rather
      // than grinding to the goal deadline.
      if (++resetsWithoutProgress >= 4)
        return { ok: false, goal: 'travel', reason: 'no_progress', ...summary(),
          remaining: +horizontal(field.latest.position, goal).toFixed(1), position: field.latest.position };
      stuck = 0;
      field.resetExploration();
      field.report('recovering_route', { remaining: +horizontal(field.latest.position, goal).toFixed(1), legs, routeResets });
    }
  }
}
