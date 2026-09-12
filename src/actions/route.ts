import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';
import { findRoute } from '../runtime/navigation/planner.ts';
import { planRoughRoute } from '../runtime/navigation/surface.ts';
import { horizontal } from '../runtime/navigation/terrain.ts';
import { sightHorizon } from '../support/fieldwork.ts';
import { nearbyThreats } from '../support/threats.ts';

// Plan only: the route the walk would take from memory, without moving.
export default defineAction({
  name: 'route',
  schema: z
    .object({
      x: z.number().finite(),
      y: z.number().finite().optional().describe('Omit to accept any elevation.'),
      z: z.number().finite(),
      arrivalRadius: z.number().min(0).max(8).default(1),
    })
    .strict(),
  readOnly: true,
  description:
    'The route memory allows to a point, without moving: checkpoints over the surroundings (status success when they reach ' +
    'the point, partial when they end at the nearest unknown cell, noPath), and beyond 12 blocks the rough route over far-view ' +
    'columns. Hostiles in memory are kept clear of. Plan only; travel and move_to plan again as they walk.',
  local: async (runtime, { x, y, z, arrivalRadius }) => {
    const state = await runtime.snapshot();
    const from = state.position;
    const goal = { x, y: y ?? from.y, z, horizontalOnly: y === undefined, arrivalRadius };
    const avoid = nearbyThreats(state).map(entity => ({ point: entity.point, minimumDistance: Math.max(0, horizontal(from, entity.point) - 0.5) }));
    const checkpoints = findRoute(runtime.map, from, goal, 0, 0, { avoid, partial: true, budget: 4096, deadlineMs: 1000 }) ?? [];
    const end = checkpoints.at(-1);
    const reached = !!end && horizontal(end, goal) <= Math.max(arrivalRadius, 0.51) && (goal.horizontalOnly || Math.abs(end.y - goal.y) < 0.6);
    let length = 0;
    for (let i = 1; i < checkpoints.length; i++) length += horizontal(checkpoints[i - 1], checkpoints[i]);
    const remaining = horizontal(from, goal);
    const rough = remaining > sightHorizon && runtime.surface ? planRoughRoute(runtime.surface, from, goal) : null;
    return {
      ok: true,
      from: { x: from.x, y: from.y, z: from.z },
      goal: { x, y: goal.y, z },
      remaining: +remaining.toFixed(1),
      status: !checkpoints.length ? 'noPath' : reached ? 'success' : 'partial',
      length: +length.toFixed(1),
      checkpoints: checkpoints.map(c => ({ x: c.x, y: c.y, z: c.z })),
      roughRoute: rough
        ? {
            status: rough.status,
            reason: rough.reason ?? null,
            explored: rough.explored,
            checkpoints: rough.checkpoints.map(c => ({ x: c.x, y: c.y, z: c.z })),
          }
        : null,
    };
  },
});
