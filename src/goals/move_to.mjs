import { z } from 'zod';
import { defineGoal } from '../controller/define.mjs';

export const schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  dimension: z.literal(0),
  horizontalOnly: z.boolean().optional(),
  sprint: z.boolean().optional(),
  arrivalRadius: z.number().min(.3).max(8).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
}).strict();

export default defineGoal({
  name: 'move_to',
  schema,
  description:
    'Navigate to feet coordinates within 128 horizontal/32 vertical blocks, dimension 0. ' +
    'horizontalOnly ignores destination elevation (supply current y); still requires observed ' +
    'safe ground. arrivalRadius is horizontal tolerance, default 0.3, max 8; exact elevation ' +
    'unless horizontalOnly. Node routing/replanning: level/down-one/jump-up-one. Requires ' +
    'grounded/dry/unmounted and controlReady. sprint=true permits sprinting only on straight ' +
    'level stretches with at least 60% food; defaults to walking. Damage, low health/oxygen or death interrupt; ' +
    'hunger alone does not. Default deadline 60s, max 120s; runs without polling. START is not ' +
    'arrival: poll goal_status by id. stop cancels; other mutations refused during a goal. ' +
    'Unknown/stale ground never traversed; no digging, swimming, doors or gap jumps. ' +
    'Unreachable/unexplored destinations may fail within budget.',
  announce: () => 'Heading over to take a look.',
  // Pure navigation holds control directly instead of a Fieldwork task.
  launch: (runtime, args, record, started) => runtime.navigate(args, record, started),
});
