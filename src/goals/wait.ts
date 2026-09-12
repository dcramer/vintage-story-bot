import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { runField } from '../support/task.ts';
import { nearestThreat } from '../support/threats.ts';

// Stay put with eyes open: nights indoors, storms, a kiln firing.
export default defineGoal({
  name: 'wait',
  schema: z
    .object({
      untilHour: z.number().min(0).max(24).optional().describe('Game hour of day to wait for; past midnight when earlier than now.'),
      ms: z.number().int().min(1000).max(3600000).optional().describe('Real milliseconds to wait.'),
      timeoutMs: z.number().int().min(1000).max(3600000).optional(),
    })
    .strict()
    .refine(a => (a.untilHour !== undefined) !== (a.ms !== undefined), 'Supply exactly one of untilHour or ms'),
  description:
    'Hold position and keep watching until a game hour or for a number of milliseconds. Ends early with reason threat when a ' +
    'hostile is seen or heard (the caller decides where to go); being hurt is reported, a life alert, death or control loss ' +
    'ends it. No eating, sheltering or fleeing of its own. Returns START; poll goal_status.',
  announce: args => (args.untilHour !== undefined ? `Waiting here until about ${Math.round(args.untilHour)}:00.` : 'Waiting here a while.'),
  run: (env, { untilHour, ms, ...options }) =>
    runField(env, { manageFood: false, ...options }, [], async field => {
      const started = field.now();
      let target = null,
        hour = null;
      while (true) {
        await field.observe();
        const waitedMs = field.now() - started;
        const threat = nearestThreat(field.latest);
        if (threat)
          return { ok: false, goal: 'wait', reason: 'threat', threat: { code: threat.code, point: threat.point, how: threat.how }, waitedMs, hour };
        if (ms !== undefined && waitedMs >= ms) return { ok: true, goal: 'wait', waitedMs, hour };
        if (untilHour !== undefined) {
          const environment = await field.send({ action: 'environment' });
          const calendar = environment.calendar ?? {};
          hour = calendar.hourOfDay ?? null;
          if (typeof calendar.totalDays === 'number' && typeof hour === 'number') {
            const hoursPerDay = calendar.hoursPerDay ?? 24;
            target ??= calendar.totalDays + (((untilHour - hour) % hoursPerDay) + hoursPerDay) / hoursPerDay;
            if (calendar.totalDays >= target) return { ok: true, goal: 'wait', waitedMs, hour };
          }
        }
        field.report('waiting', { waitedMs, hour, untilHour, ms });
        await field.wait(1000);
      }
    }),
});
