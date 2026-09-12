import { z } from 'zod';
import { defineGoal } from '../runtime/define.mjs';
import { runField } from '../support/task.mjs';

export default defineGoal({
  name: 'explore',
  schema: z.object({
    legs: z.number().int().min(1).max(16).default(4).describe('Exploration legs of up to 48 blocks, preferring unvisited regions.'),
    heading: z.number().min(0).max(360).optional().describe('Initial yaw in degrees; defaults to current facing.'),
    manageFood: z.boolean().default(false),
    sprint: z.boolean().default(false),
    timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  }).strict(),
  destructive: true,
  description:
    'Walk exploration legs and scan after each; returns final position/heading and counts of sighted object codes ' +
    '(memory only, revalidate before acting). Food/interruption rules as gather_sticks. Returns START; poll goal_status.',
  announce: () => 'Exploring the area a bit.',
  run: (env, { legs = 4, heading, ...options }) => runField(env, { manageFood: false, ...options }, [], async (field, survival) => {
    if (heading !== undefined) field.heading = heading;
    const results = [];
    for (let i = 0; i < legs; i++) {
      await survival?.tend();
      field.report('exploring', { leg: i + 1, legs });
      const result = await field.walk(field.explore(), survival?.pauseWhen);
      results.push(result.state);
      await field.scan(64, '', 'all');
    }
    const sightings = {};
    for (const o of field.seen.values()) sightings[o.code] = (sightings[o.code] ?? 0) + 1;
    return { ok: true, goal: 'explore', legs: results, moved: +field.moved.toFixed(1), position: field.latest.position, heading: field.heading,
      sightings: Object.fromEntries(Object.entries(sightings).sort((a, b) => b[1] - a[1]).slice(0, 48)) };
  }),
});
