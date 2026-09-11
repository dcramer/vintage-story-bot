import { horizontal } from '../navigation/terrain.mjs';

// Chain bounded navigation legs toward a far destination; exploration legs detour around unknown terrain.
export async function travel(field, survival, { x, y, z, arrivalRadius = 1 }) {
  let stalled = 0, legs = 0;
  const summary = () => ({ moved: +field.moved.toFixed(1), legs, stalled });
  while (true) {
    const state = await field.observe(true);
    await survival?.tend();
    const goal = { x, y: y ?? state.position.y, z };
    const remaining = horizontal(state.position, goal);
    if (remaining <= arrivalRadius && (y === undefined || Math.abs(state.position.y - y) < 1.5))
      return { ok: true, goal: 'travel', ...summary(), remaining: +remaining.toFixed(1), position: state.position };
    field.report('travelling', { remaining: +remaining.toFixed(1), legs });
    const leg = remaining <= 48
      ? (y === undefined ? { x, y: state.position.y, z, horizontalOnly: true, arrivalRadius } : { x, y, z, arrivalRadius })
      : field.explore(goal);
    const before = state.position;
    const result = await field.walk(leg, survival?.yieldWhen);
    legs++;
    const progress = horizontal(before, field.latest.position);
    if (result.state === 'arrived' || result.state === 'yielded' || progress > 2) stalled = 0;
    else if (++stalled >= 6) return { ok: false, reason: 'no_progress', ...summary(), remaining: +remaining.toFixed(1), position: field.latest.position };
  }
}
