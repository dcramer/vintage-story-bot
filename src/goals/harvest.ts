import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { horizontal } from '../runtime/navigation/terrain.ts';
import { blockWorkReady, changeBlock, dryBlockWorkPosition } from '../support/blocks.ts';
import { habitatsFor } from '../support/habitat.ts';
import { equip, ownedSlots } from '../support/inventory.ts';
import { Search } from '../support/search.ts';
import { cleanName, runField } from '../support/task.ts';
import { terrainTargets } from '../support/terrain-targets.ts';
import { collectItem } from './collect_item.ts';

const includes = (code, part) => typeof code === 'string' && code.includes(part);
export const failedDropRetryMs = 600000;

export async function collectHarvestDrop(field, object, collect = collectItem) {
  field.report('collecting', { target: object.key });
  let collected = false;
  try {
    const result = await collect(field, { target: object.key, expectedItem: object.code, radius: 8 });
    collected = result.ok;
    if (!collected) field.skip(object, failedDropRetryMs);
  } catch (error) {
    if (/interruption|cancelled|deadline/i.test(error.message)) throw error;
    field.skip(object, failedDropRetryMs);
  }
  field.seen.delete(object.key);
  return collected;
}

export const matchesHarvestBlock = (object, match, item) => {
  if (object.kind !== 'block' || !includes(object.code, match)) return false;
  // The reed handbook combines both states' drops. Cut stems only yield
  // roots; their visible harvested state cannot satisfy a tops-only request.
  const cutReed = /:tallplant-coopersreed-(land|water)-harvested-/.test(object.code);
  return !(cutReed && includes('game:cattailtops', item) && !includes('game:cattailroot', item));
};
export const matchingCount = (inventory, part) =>
  ownedSlots(inventory)
    .filter(s => includes(s.code, part))
    .reduce((n, s) => n + s.quantity, 0);

// Dig visible blocks matching `match` with an optional tool class until `count` drops containing `item` are carried.
export async function harvest(field, survival, { match, item, count, tool, minTier = 0, lowest = false }) {
  const blocks = o => matchesHarvestBlock(o, match, item);
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
  const search = new Search(field, {
    kind: match,
    memoryRange: 256,
    candidates: () => terrainTargets(field, [match]),
    match: [match.slice(0, 64), item.slice(0, 64)],
    wanted: o => blocks(o) || drops(o),
    // Drops lie nearby and vanish over time, so they come first. A player digs
    // into a bank or the surface around, never a shaft under their own feet:
    // blocks below the ground the bot stands on are left alone, higher ones
    // (a slope face) come first.
    ready: (o, state) =>
      o.kind === 'item'
        ? horizontal(state.position, o.point) <= 8
        : o.withinPickingRange &&
          blockWorkReady(state) &&
          (Math.floor(o.point.x) !== Math.floor(state.position.x) || Math.floor(o.point.z) !== Math.floor(state.position.z)) &&
          (lowest || o.point.y >= Math.floor(state.position.y) - 1),
    prefer: (a, b) =>
      Number(a.kind === 'block') - Number(b.kind === 'block') ||
      (lowest ? a.point.y - b.point.y : Math.floor(b.point.y) - Math.floor(a.point.y)) ||
      horizontal(a.point, field.latest.position) - horizontal(b.point, field.latest.position),
    take: async o => {
      if (o.kind === 'item') return collectHarvestDrop(field, o);
      const slot = await held();
      inventory = await field.send({ action: 'inventory' });
      field.report('digging', { target: o.key });
      let result;
      try {
        result = await changeBlock(field, 'dig', { target: o.key, slot, acceptTransform: true });
      } catch (error) {
        if (/interruption|cancelled|deadline|Selected item changed/i.test(error.message)) throw error;
        result = { ok: false, reason: error.message };
      }
      field.seen.delete(o.key);
      field.skip(o, result.ok ? 120000 : 30000);
      if (result.ok) dug++;
      else field.report('dig_failed', { target: o.key, reason: result.reason });
      return true;
    },
    approachExclude: target =>
      target.kind === 'block'
        ? q => !dryBlockWorkPosition(q) || (Math.floor(q.x) === Math.floor(target.point.x) && Math.floor(q.z) === Math.floor(target.point.z))
        : null,
    habitats: habitatsFor(match),
    pauseWhen: survival?.pauseWhen ?? null,
  });
  await field.aim({ yawDegrees: field.heading, pitchDegrees: 15 });
  while (true) {
    await field.observe(true);
    if ((await refresh()) >= count) return { ok: true, goal: 'harvest', ...summary(), verification: 'inventory_delta' };
    await survival?.tend();
    if (search.pit || search.exhausted())
      return {
        ok: false,
        goal: 'harvest',
        reason: search.pit ? 'pit' : 'none_found',
        position: field.latest.position,
        ...(search.pit ? { toward: search.pitToward } : {}),
        ...summary(),
      };
    field.report('searching');
    await search.step();
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
    sprint: z.boolean().optional().describe('false forbids running; by default the walk runs where there is room and food allows'),
    timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  })
  .strict();

export default defineGoal({
  name: 'harvest',
  schema,
  destructive: true,
  description:
    'Dig visible blocks whose code contains match with the requested tool, walking between them, collecting matching drops and ' +
    'verifying carried gain until count. Transformed blocks (reeds → harvested) count when drops appear. Searches like gather; ' +
    'no default deadline. Food management pauses for berries below 20%. Damage/death/control loss interrupt. Returns START; poll goal_status.',
  title: args => `Harvest ${args.count} × ${cleanName(args.item)}`,
  announce: args => `Off to gather ${cleanName(args.item ?? args.match)}.`,
  run: (env, options) => runField(env, { manageFood: false, ...options }, ['inventory', 'block_actions'], harvest),
});
