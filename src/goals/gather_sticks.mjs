import { z } from 'zod';
import { defineGoal } from '../controller/define.mjs';
import { horizontal } from '../navigation/terrain.mjs';
import { area, Fieldwork, sightRange } from '../skills/fieldwork.mjs';
import { Survival } from '../skills/survival.mjs';

const loose = o => o.kind === 'block' && /^game:loosestick-(free|snow)$/.test(o.code);
const dropped = o => o.kind === 'item' && o.code === 'game:stick';
export const stickCount = state => [...state.hotbar, ...state.backpack]
  .filter(slot => slot.code === 'game:stick').reduce((n, slot) => n + slot.quantity, 0);

export async function gather(env, { count = 10, manageFood = true, ...options } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 64) throw Error('count must be 1–64');
  const field = new Fieldwork(env, options);
  const survival = manageFood ? new Survival(field) : null;
  field.recoveringFood = manageFood;
  const gained = () => field.initial ? stickCount(field.latest) - stickCount(field.initial) : 0;
  // Preserve parent-task progress when a composed food or movement skill reports.
  field.report = (phase, extra = {}) => env.report?.({ phase, count, gained: gained(),
    moved: +field.moved.toFixed(1), searched: field.searched, eaten: survival?.eaten ?? 0, ...extra });
  try {
    await field.start(manageFood ? ['forage_state', 'food_freshness', 'block_actions'] : []);
    await field.aim({ yawDegrees: field.heading, pitchDegrees: 15 });
    while (true) {
      await field.observe(true);
      if (gained() >= count) return { ok: true, goal: 'gather_sticks', count, gained: gained(),
        eaten: survival?.eaten ?? 0, harvested: survival?.harvested ?? 0,
        moved: +field.moved.toFixed(1), searched: field.searched };
      await survival?.tend();
      field.report('searching');
      const objects = await field.scan(8, 'stick');
      if (!objects.some(o => loose(o) && o.withinPickingRange)) await field.scan(sightRange, 'stick');
      const ready = objects.find(o => loose(o) && o.withinPickingRange && !field.rejected.has(o.key));
      if (ready) {
        field.report('pickup', { target: ready.key });
        await field.aim(ready.look);
        const aimed = await field.observe();
        if (aimed.target?.key === ready.key) {
          const before = stickCount(aimed);
          await field.send({ action: 'interact', expectedTarget: ready.key, durationMs: 150 });
          await field.wait(500);
          const after = await field.observe();
          if (stickCount(after) > before) field.seen.delete(ready.key);
          else field.reject(ready);
          field.report('verified', { target: ready.key });
        } else field.reject(ready, 5000);
      }
      await field.observe(true);
      if (gained() >= count) continue;
      const target = field.targets(o => loose(o) || dropped(o))[0];
      if (target) {
        const destination = field.approach(target);
        if (destination) {
          const result = await field.walk(destination, survival?.yieldWhen);
          if (!['arrived', 'yielded'].includes(result.state)) field.reject(target, 15000);
          continue;
        }
        if (horizontal(field.latest.position, target.point) > 6) {
          const result = await field.walk(field.explore(target.point), survival?.yieldWhen);
          if (!['arrived', 'yielded'].includes(result.state)) field.reject(target, 15000);
          continue;
        }
        field.reject(target, 15000);
      }
      const tree = o => o.code.startsWith('game:leaves-') && !field.visits.has(area(o.point));
      if (!field.targets(tree).length) await field.scan(sightRange, 'leaves', 'blocks');
      const destination = field.explore(field.targets(tree)[0]?.point);
      await field.walk(destination, survival?.yieldWhen);
    }
  } finally {
    await env.send({ action: 'stop' });
  }
}

export default defineGoal({
  name: 'gather_sticks',
  schema: z.object({
    count: z.number().int().min(1).max(64).optional(),
    manageFood: z.boolean().optional(),
    sprint: z.boolean().optional(),
    timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  }).strict(),
  destructive: true,
  description:
    'Collect additional ground sticks only (default 10): scan, navigate, pick up and verify ' +
    'inventory gain. Food management defaults on: yields below 20% satiety to forage/eat fresh ' +
    'berries to 80% plus a reserve. Set manageFood=false for ground-stick-only runs. ' +
    'Optional sprint=true permits safe, well-fed straight travel. No leaf harvesting. ' +
    'Runs until count is reached or gameplay/cancellation ' +
    'interrupts; timeoutMs is optional, no default deadline. Failed routes trigger further ' +
    'search, not goal completion. Returns START and goal.id; poll observe.goal.progress/result. ' +
    'stop cancels globally.',
  announce: () => 'Collecting some sticks.',
  run: gather,
});
