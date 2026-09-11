import { horizontal } from '../navigation/terrain.mjs';
import { temporalStormUnsafe } from './fieldwork.mjs';
import { nearestThreat } from './threats.mjs';
import { clearFoliagePath } from './clearance.mjs';

export const routeRegressed = (best, current, margin = 12) => current > best + margin;

const guardStorm = state => {
  if (temporalStormUnsafe(state)) throw Error('Temporal storm active or imminent; travel postponed.');
};

// Chain bounded navigation legs toward a far destination; exploration legs detour around unknown terrain.
export async function travel(field, survival, { x, y, z, arrivalRadius = 1 }) {
  let stalled = 0, legs = 0, routeResets = 0, continuation = null, localDetour = false;
  let bestRemaining = Infinity;
  const summary = () => ({ moved: +field.moved.toFixed(1), legs, stalled, routeResets });
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
    field.report('travelling', { remaining: +remaining.toFixed(1), legs });
    const leg = remaining <= 48 && !localDetour
      ? (y === undefined ? { x, y: state.position.y, z, horizontalOnly: true, arrivalRadius } : { x, y, z, arrivalRadius })
      : continuation ?? field.explore(goal, Math.min(48, remaining));
    const before = state.position;
    const result = await field.walk(leg, current => {
      if (temporalStormUnsafe(current)) return 'temporal_storm';
      const survivalReason = survival?.yieldWhen(current);
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
    continuation = !['arrived', 'yielded'].includes(result.state) && progress > 2 ? leg : null;
    if (result.reason === 'route_regressed') {
      continuation = null;
      field.penalize(leg);
      // The regression budget belongs to one route attempt. Once that route
      // yields, its verified recovery position becomes the next attempt's
      // baseline; retaining the older best makes every replacement route
      // yield on its first observation without taking a step.
      bestRemaining = horizontal(field.latest.position, goal);
    }
    // A nearby destination can still sit behind a dense tree line, ridge or
    // cliff. After one stationary direct attempt, use the same deterministic
    // forward/lateral frontier search as long travel instead of retrying an
    // identical unobserved segment forever.
    localDetour = remaining <= 48 && !['arrived', 'yielded'].includes(result.state) && progress <= 2;
    if (result.state === 'arrived' || result.state === 'yielded' || progress > 2) stalled = 0;
    else {
      stalled++;
      if (stalled >= 3) {
        const cleared = await clearFoliagePath(field, leg);
        const nudged = await field.nudge(leg);
        if (cleared || nudged > .1) {
          // Once a cautious probe proves this corridor is physically
          // traversable, retry it after one planner failure instead of
          // waiting through three identical surveys for every half block.
          stalled = nudged > .1 ? 2 : 0;
          continuation = null;
          localDetour = false;
          field.report('route_cleared', { remaining: +horizontal(field.latest.position, goal).toFixed(1), legs });
          continue;
        }
      }
      if (stalled < 6) continue;
      // A long trip can exhaust every local alternative on a steep ridge even
      // though a fresh per-goal visit history immediately finds a route. Reset
      // only that soft penalty and rotate the deterministic search; observed
      // terrain, rejected resources and the task deadline remain intact.
      routeResets++;
      stalled = 0;
      field.resetExploration();
      field.report('recovering_route', { remaining: +horizontal(field.latest.position, goal).toFixed(1), legs, routeResets });
    }
  }
}
