import { horizontal } from '../navigation/terrain.mjs';
import { temporalStormUnsafe } from './fieldwork.mjs';

const guardStorm = state => {
  if (temporalStormUnsafe(state)) throw Error('Temporal storm active or imminent; travel postponed.');
};

// Chain bounded navigation legs toward a far destination; exploration legs detour around unknown terrain.
export async function travel(field, survival, { x, y, z, arrivalRadius = 1 }) {
  let stalled = 0, legs = 0, routeResets = 0, continuation = null;
  const summary = () => ({ moved: +field.moved.toFixed(1), legs, stalled, routeResets });
  while (true) {
    let state = await field.observe(true);
    guardStorm(state);
    let goal = { x, y: y ?? state.position.y, z };
    await survival?.tend({ toward: goal });
    // Food recovery may travel a meaningful distance and elevation. Resume
    // from its verified final observation rather than planning from stale state.
    state = field.latest;
    goal = { x, y: y ?? state.position.y, z };
    const remaining = horizontal(state.position, goal);
    if (remaining <= arrivalRadius && (y === undefined || Math.abs(state.position.y - y) < 1.5))
      return { ok: true, goal: 'travel', ...summary(), remaining: +remaining.toFixed(1), position: state.position };
    field.report('travelling', { remaining: +remaining.toFixed(1), legs });
    const leg = remaining <= 48
      ? (y === undefined ? { x, y: state.position.y, z, horizontalOnly: true, arrivalRadius } : { x, y, z, arrivalRadius })
      : continuation ?? field.explore(goal);
    const before = state.position;
    const result = await field.walk(leg, current => temporalStormUnsafe(current) ? 'temporal_storm' : survival?.yieldWhen(current));
    guardStorm(field.latest);
    legs++;
    const progress = horizontal(before, field.latest.position);
    // A partial frontier can end a valid leg after moving only partway around
    // a large ridge or forest barrier. Keep extending that same detour while
    // each fresh terrain cache makes real progress; changing compass targets
    // immediately sends the bot back across the cells it just traversed.
    continuation = !['arrived', 'yielded'].includes(result.state) && progress > 2 ? leg : null;
    if (result.state === 'arrived' || result.state === 'yielded' || progress > 2) stalled = 0;
    else if (++stalled >= 6) {
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
