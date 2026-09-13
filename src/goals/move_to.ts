import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { destinationName } from '../support/task.ts';

export const schema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
    dimension: z.literal(0),
    horizontalOnly: z.boolean().optional(),
    sprint: z.boolean().optional(),
    arrivalRadius: z.number().min(0.3).max(8).optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
  })
  .strict();

export default defineGoal({
  name: 'move_to',
  schema,
  description:
    'Navigate to feet coordinates within 128 horizontal/32 vertical blocks, dimension 0. ' +
    'horizontalOnly ignores destination elevation (supply current y); still requires observed ' +
    'safe ground. arrivalRadius is horizontal tolerance, default 0.3, max 8; exact elevation ' +
    'unless horizontalOnly. Node routing/replanning: level/down-one/jump-up-one. Requires ' +
    'support on ground or water, unmounted and controlReady; a brief bob above observed deep water waits for support. ' +
    'sprint=true permits sprinting on suitable observed terrain with enough satiety; defaults to walking. Low health/oxygen or death interrupt; ' +
    'hunger alone does not. Default deadline 60s, max 120s; runs without polling. START is not ' +
    'arrival: poll goal_status by id. stop cancels; other mutations refused during a goal. ' +
    'Unknown/stale ground never traversed; observed water can be waded or swum. No digging or doors. ' +
    'Unreachable/unexplored destinations may fail within budget.',
  title: args => `Move to ${destinationName(args)}`,
  announce: () => 'Heading over to take a look.',
  compose: async (_runtime, env, args) => {
    const navigation = await env.navigate(args);
    if (navigation.state !== 'arrived') throw Error(navigation.reason ?? `Navigation ${navigation.state}`);
    return { ok: true, goal: 'move_to', navigation };
  },
  // Pure navigation holds control directly instead of a Fieldwork task.
  launch: (runtime, args, record, started, signal) => runtime.navigate(args, record, started, undefined, {}, signal),
});
