import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { horizontal } from '../runtime/navigation/terrain.ts';
import { changeBlock } from '../support/blocks.ts';
import { Fieldwork, sightRange } from '../support/fieldwork.ts';
import { pickupBlock } from '../support/gleaning.ts';
import { habitatsFor } from '../support/habitat.ts';
import { Survival } from '../support/survival.ts';
import { cleanName, foodFeatures } from '../support/task.ts';

// Things lying on the ground: loose sticks, stones and flints (a right-click
// each) and dropped stacks (walked over). match is the code substring looked
// for; item is the carried code substring that proves a pickup. Sticks also
// come from branchy leaves, the twiggy inner canopy of a tree: one stick per
// block broken, so those in reach are broken and their drop walked over.
export const TWIGS = 'leavesbranchy';
export const carried = (state, item) =>
  [...state.hotbar, ...state.backpack].filter(slot => slot.code?.includes(item)).reduce((n, slot) => n + slot.quantity, 0);

export async function gather(env, { match = 'stick', item = match, count = 10, manageFood = false, ...options }: any = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 64) throw Error('count must be 1–64');
  const wanted = code => code?.toLowerCase().includes(match.toLowerCase());
  const loose = o => pickupBlock(o) && wanted(o.code);
  const dropped = o => o.kind === 'item' && wanted(o.code);
  const sticks = wanted('stick');
  const twiggy = o => sticks && o.kind === 'block' && o.code.includes(TWIGS);
  const looking = sticks ? [match, TWIGS] : match;
  const field = new Fieldwork(env, options);
  const survival = manageFood ? new Survival(field) : null;
  field.recoveringFood = manageFood;
  const gained = () => (field.initial ? carried(field.latest, item) - carried(field.initial, item) : 0);
  // Preserve parent-task progress when a composed food or movement skill reports.
  field.report = (phase, extra = {}) =>
    env.report?.({
      phase,
      match,
      count,
      gained: gained(),
      moved: +field.moved.toFixed(1),
      searched: field.searched,
      eaten: survival?.eaten ?? 0,
      ...extra,
    });
  try {
    await field.start(manageFood ? foodFeatures : []);
    await field.aim({ yawDegrees: field.heading, pitchDegrees: 15 });
    while (true) {
      await field.observe(true);
      if (gained() >= count)
        return {
          ok: true,
          goal: 'gather',
          match,
          item,
          count,
          gained: gained(),
          eaten: survival?.eaten ?? 0,
          harvested: survival?.harvested ?? 0,
          moved: +field.moved.toFixed(1),
          searched: field.searched,
        };
      await survival?.tend();
      field.report('searching');
      const objects = await field.scan(8, looking);
      if (!objects.some(o => (loose(o) || twiggy(o)) && o.withinPickingRange)) await field.scan(sightRange, looking);
      const ready = objects.find(o => loose(o) && o.withinPickingRange && !field.skipped.has(o.key));
      const twigs = ready ? null : objects.find(o => twiggy(o) && o.withinPickingRange && !field.skipped.has(o.key));
      if (ready) {
        field.report('pickup', { target: ready.key });
        await field.aim(ready.look);
        const aimed = await field.observe();
        if (aimed.target?.key === ready.key) {
          const before = carried(aimed, item);
          await field.send({ action: 'interact', expectedTarget: ready.key, durationMs: 150 });
          await field.wait(500);
          const after = await field.observe();
          if (carried(after, item) > before) field.seen.delete(ready.key);
          else field.skip(ready);
          field.report('verified', { target: ready.key });
        } else field.skip(ready, 5000);
      } else if (twigs) {
        field.report('breaking', { target: twigs.key });
        let result;
        try {
          result = await changeBlock(field, 'dig', { target: twigs.key, acceptTransform: true, timeoutMs: 20000 });
        } catch (error) {
          if (/interruption|cancelled|deadline|Selected item changed/i.test(error.message)) throw error;
          result = { ok: false, reason: error.message };
        }
        field.seen.delete(twigs.key);
        field.skip(twigs, result.ok ? 120000 : 30000);
        if (!result.ok) field.report('dig_failed', { target: twigs.key, reason: result.reason });
      }
      await field.observe(true);
      if (gained() >= count) continue;
      // Nothing in view: what memory holds within sixty blocks is worth going back for.
      if (!field.targets(o => loose(o) || dropped(o) || twiggy(o)).length) field.recall(64, looking, 'all');
      // What lies about is picked up first; twigs are for when nothing loose is close.
      const near = field.targets(o => loose(o) || dropped(o)).filter(o => horizontal(field.latest.position, o.point) <= 16);
      const target = near[0] ?? field.targets(o => loose(o) || dropped(o) || twiggy(o))[0];
      if (target) {
        const destination = field.approach(target);
        if (destination) {
          const result = await field.walk(destination, survival?.pauseWhen);
          if (!['arrived', 'paused'].includes(result.state)) field.skip(target, 15000);
          continue;
        }
        if (horizontal(field.latest.position, target.point) > 6) {
          const result = await field.walk(field.explore(target.point), survival?.pauseWhen);
          if (!['arrived', 'paused'].includes(result.state)) field.skip(target, 15000);
          continue;
        }
        field.skip(target, 15000);
      }
      // Sticks lie under trees; anything else is looked for in the open.
      const tree = o => sticks && o.code.startsWith('game:leaves') && !field.places.known(o.point);
      if (sticks && !field.targets(tree).length) await field.scan(sightRange, ['leaves', TWIGS], 'blocks');
      // Nothing seen: toward the nearest unwalked place such things are found.
      const destination = field.explore(field.targets(tree)[0]?.point ?? field.habitat(habitatsFor(match)));
      await field.walk(destination, survival?.pauseWhen);
    }
  } finally {
    await env.send({ action: 'stop' });
  }
}

export default defineGoal({
  name: 'gather',
  schema: z
    .object({
      match: z.string().min(1).max(64).default('stick').describe('Code substring of what lies on the ground: stick, loosestones, flint.'),
      item: z.string().min(1).max(64).optional().describe('Carried code substring that proves a pickup; defaults to match (stones: stone-).'),
      count: z.number().int().min(1).max(64).default(10),
      manageFood: z.boolean().optional(),
      sprint: z.boolean().optional(),
      timeoutMs: z.number().int().min(1000).max(3600000).optional(),
    })
    .strict(),
  destructive: true,
  description:
    'Pick up count more of something lying on the ground: loose sticks, stones and flints by right-click, dropped stacks by ' +
    'walking over them; look around, nearest seen first, walk, pick up, verify the carried gain, repeat. Sticks are also broken ' +
    'out of branchy leaves (the twiggy inner canopy, one stick each) when none lie close. No other digging or harvesting. manageFood=true pauses below 20% satiety to forage; sprint=true permits safe, well-fed straight travel. ' +
    'No default deadline; failed routes lead to more searching. Returns START; poll goal_status.',
  announce: args => `Collecting some ${cleanName(args.item ?? args.match ?? 'stick')}s.`,
  run: gather,
});
