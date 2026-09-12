import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { parseGoalScript } from '../runtime/goal-script.ts';

const intent = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'intent cannot contain control characters');

export default defineGoal({
  name: 'goal_script',
  schema: z
    .object({
      intent: intent.describe('High-level outcome shown to operators while every step runs.'),
      goalScript: z
        .string()
        .min(1)
        .max(8192)
        .describe('TypeScript-compatible sequence of `await goals.<goal>({ ...literalArgs });` calls. Use api for goal schemas.'),
    })
    .strict()
    .superRefine(({ goalScript }, context) => {
      try {
        parseGoalScript(goalScript);
      } catch (error) {
        context.addIssue({ code: 'custom', path: ['goalScript'], message: error.message });
      }
    }),
  destructive: true,
  description:
    'Run a temporary high-level goal composed from up to 16 existing goals. Supply a stable operator-facing intent and a ' +
    'TypeScript-compatible linear script such as `async () => { await goals.forage({ count: 32 }); await goals.travel({ x: 1, z: 2 }); }`. ' +
    'Only literal arguments and sequential calls through the allow-listed goals API are accepted; no variables, loops, imports, ' +
    'network, filesystem or arbitrary JavaScript. The controller stores the original intent/goalScript in its goal record and ' +
    'reports the current subgoal separately. Returns START; poll goal_status.',
  announce: args => `Goal: ${args.intent}`,
  launch: (runtime, args, record, started, signal) => runtime.runGoalScript(args, record, started, signal),
});
