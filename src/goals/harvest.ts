import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { horizontal } from '../runtime/navigation/terrain.ts';
import { changeBlock } from '../support/blocks.ts';
import { area } from '../support/fieldwork.ts';
import { equip, ownedSlots } from '../support/inventory.ts';
import { cleanName, runField } from '../support/task.ts';
import { collectItem } from './collect_item.ts';

const includes = (code, part) => typeof code === 'string' && code.includes(part);
export const matchingCount = (inventory, part) =>
  ownedSlots(inventory)
    .filter(s => includes(s.code, part))
    .reduce((n, s) => n + s.quantity, 0);

// Dig visible blocks matching `match` with an optional tool class until `count` drops containing `item` are carried.
export async function harvest(field, survival, { match, item, count, tool, minTier = 0, lowest = false }) {
  const blocks = o => o.kind === 'block' && includes(o.code, match);
  const drops = o => o.kind === 'item' && includes(o.code, item);
  let inventory = await field.send({ action: 'inventory' });
  if (tool !== undefined && !ownedSlots(inventory).some(s => s.tool === tool && s.toolTier >= minTier && s.durability > 0))
    throw Error(`Missing tool: no ${tool}${minTier ? ` of tier ${minTier}` : ''} carried`);
  const initial = matchingCount(inventory, item);
  const gained = () => matchingCount(inventory, item) - initial;
  const refresh = async () => {
    await field.observe();
    inventory = await field.send({ action: 'inventory' });
    return gained();
  };
  let dug = 0;
  const summary = () => ({
    match,
    item,
    count,
    gained: gained(),
    dug,
    moved: +field.moved.toFixed(1),
    searched: field.searched,
    eaten: survival?.eaten ?? 0,
  });
  field.report = (phase, extra = {}) => field.env.report?.({ phase, ...summary(), ...extra });
  const held = async () => {
    if (tool === undefined) return undefined;
    const current = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && s.slot === field.latest.activeSlot);
    if (current?.tool === tool && current.toolTier >= minTier && current.durability > 0) return current.slot;
    return (await equip(field, { tool, minTier })).slot;
  };
  await field.aim({ yawDegrees: field.heading, pitchDegrees: 15 });
  while (true) {
    await field.observe(true);
    if ((await refresh()) >= count) return { ok: true, goal: 'harvest', ...summary(), verification: 'inventory_delta' };
    await survival?.tend();
    field.report('searching');
    // Drops first: dug items lie nearby and vanish over time.
    const visibleDrops = (await field.scan(8, item.slice(0, 64), 'items')).filter(o => drops(o) && !field.skipped.has(o.key));
    for (const drop of visibleDrops.sort((a, b) => horizontal(a.point, field.latest.position) - horizontal(b.point, field.latest.position))) {
      field.report('collecting', { target: drop.key });
      try {
        const result = await collectItem(field, { target: drop.key, expectedItem: drop.code, radius: 8 });
        if (!result.ok) field.skip(drop, 20000);
      } catch (error) {
        if (/interruption|cancelled|deadline/i.test(error.message)) throw error;
        field.skip(drop, 20000);
      }
      field.seen.delete(drop.key);
      if ((await refresh()) >= count) break;
    }
    if (gained() >= count) continue;
    const near = (await field.scan(8, match.slice(0, 64), 'blocks')).filter(o => blocks(o) && o.withinPickingRange && !field.skipped.has(o.key));
    const ready = near.sort(
      (a, b) => (lowest ? a.point.y - b.point.y : 0) || horizontal(a.point, field.latest.position) - horizontal(b.point, field.latest.position),
    )[0];
    if (ready) {
      const slot = await held();
      inventory = await field.send({ action: 'inventory' });
      field.report('digging', { target: ready.key });
      let result;
      try {
        result = await changeBlock(field, 'dig', { target: ready.key, slot, acceptTransform: true });
      } catch (error) {
        if (/interruption|cancelled|deadline|Selected item changed/i.test(error.message)) throw error;
        result = { ok: false, reason: error.message };
      }
      field.seen.delete(ready.key);
      field.skip(ready, result.ok ? 120000 : 30000);
      if (result.ok) dug++;
      else field.report('dig_failed', { target: ready.key, reason: result.reason });
      continue;
    }
    // Nothing known nearby: look all around before walking anywhere.
    if (!field.targets(blocks).length) await field.lookAround(match.slice(0, 64));
    const target = field.targets(blocks)[0];
    if (target) {
      const destination = field.approach(
        target,
        q => Math.floor(q.x) === Math.floor(target.point.x) && Math.floor(q.z) === Math.floor(target.point.z),
      );
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
    const unvisited = o => blocks(o) && !field.visits.has(area(o.point));
    await field.walk(field.explore(field.targets(unvisited)[0]?.point), survival?.pauseWhen);
  }
}

export const schema = z
  .object({
    match: z.string().min(1).max(64).describe('Block code substring to dig, e.g. coopersreed, soil-, peat, tallgrass, mushroom.'),
    item: z.string().min(1).max(64).describe('Drop code substring counted as progress, e.g. cattailtops, game:soil-, drygrass.'),
    count: z.number().int().min(1).max(256).default(8),
    tool: z.string().min(1).max(64).optional().describe('Required tool class, e.g. Knife, Axe, Shovel; equips the lowest adequate tier.'),
    minTier: z.number().int().min(0).max(20).optional(),
    manageFood: z.boolean().default(false),
    sprint: z.boolean().default(false),
    timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  })
  .strict();

export default defineGoal({
  name: 'harvest',
  schema,
  destructive: true,
  description:
    'Dig visible blocks whose code contains match with the requested tool, walking between them, collecting matching drops and ' +
    'verifying carried gain until count. Transformed blocks (reeds → harvested) count when drops appear. Searches like gather_sticks; ' +
    'no default deadline. Food management pauses for berries below 20%. Damage/death/control loss interrupt. Returns START; poll goal_status.',
  announce: args => `Off to gather ${cleanName(args.item ?? args.match)}.`,
  run: (env, options) => runField(env, { manageFood: false, ...options }, ['inventory', 'block_actions'], harvest),
});
