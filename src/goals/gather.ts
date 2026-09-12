import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { blockWorkReady, changeBlock, dryBlockWorkPosition } from '../support/blocks.ts';
import { Fieldwork } from '../support/fieldwork.ts';
import { Gleaner, pickupBlock } from '../support/gleaning.ts';
import { habitatsFor } from '../support/habitat.ts';
import { Search } from '../support/search.ts';
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
  const picker = new Gleaner(field, []);
  const search = new Search(field, {
    kind: match,
    watch: sticks ? [match, TWIGS] : [match],
    wanted: o => loose(o) || dropped(o) || twiggy(o),
    // Loose things in reach are picked up; twigs are broken only with dry footing and when nothing loose is close.
    ready: (o, state) => o.kind === 'block' && o.withinPickingRange && (loose(o) || blockWorkReady(state)),
    prefer: (a, b) => Number(twiggy(a)) - Number(twiggy(b)),
    take: async o => {
      if (loose(o)) {
        field.report('pickup', { target: o.key });
        const ok = await picker.pickup(o);
        if (ok) field.seen.delete(o.key);
        else field.skip(o, 5000);
        field.report('verified', { target: o.key });
        return true;
      }
      field.report('breaking', { target: o.key });
      let result;
      try {
        result = await changeBlock(field, 'dig', { target: o.key, acceptTransform: true, timeoutMs: 20000 });
      } catch (error) {
        if (/interruption|cancelled|deadline|Selected item changed/i.test(error.message)) throw error;
        result = { ok: false, reason: error.message };
      }
      field.seen.delete(o.key);
      field.skip(o, result.ok ? 120000 : 30000);
      if (!result.ok) field.report('dig_failed', { target: o.key, reason: result.reason });
      return true;
    },
    approachExclude: target => (twiggy(target) ? q => !dryBlockWorkPosition(q) : null),
    habitats: habitatsFor(match),
    pauseWhen: survival?.pauseWhen ?? null,
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
      await search.step();
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
    'walking over them; take what is in reach, walk to what is in view, go back for what was seen, else range toward the ' +
    'least-walked ground, and verify the carried gain. Sticks are also broken out of branchy leaves (the twiggy inner canopy, ' +
    'one stick each) when none lie close. No other digging or harvesting. manageFood=true pauses below 20% satiety to forage; ' +
    'sprint=true permits safe, well-fed straight travel. No default deadline. Returns START; poll goal_status.',
  announce: args => `Collecting some ${cleanName(args.item ?? args.match ?? 'stick')}s.`,
  run: gather,
});
