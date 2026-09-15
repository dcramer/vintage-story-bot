import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { horizontal } from '../runtime/navigation/terrain.ts';
import { learnYields } from '../support/facts.ts';
import { habitatsFor } from '../support/habitat.ts';
import { itemCount } from '../support/inventory.ts';
import { Search } from '../support/search.ts';
import { cleanName, runField } from '../support/task.ts';
import { has } from '../support/traits.ts';
import { butcher } from './butcher.ts';
import { collectItem } from './collect_item.ts';
import { throwAt } from './throw.ts';

async function countTool(field, tool) {
  const inventory = await field.send({ action: 'inventory' });
  return inventory.inventories
    .filter(part => ['hotbar', 'backpack'].includes(part.name))
    .flatMap(part => part.slots)
    .filter(slot => slot.tool === tool)
    .reduce((count, slot) => count + slot.quantity, 0);
}

async function recoverProjectile(field, weaponCode, expectedCount, knownKey = null) {
  if (!weaponCode) return false;
  const before = itemCount(await field.send({ action: 'inventory' }), weaponCode);
  if (before >= expectedCount) return true;
  const drops = await field.scan(16, weaponCode, 'items');
  const drop = drops.find(object => object.key === knownKey) ?? drops[0];
  if (!drop) return false;
  const result = await collectItem(field, { target: drop.key, expectedItem: weaponCode, radius: 16 });
  return result.ok && itemCount(await field.send({ action: 'inventory' }), weaponCode) >= expectedCount;
}

export async function hunt(env, { match = 'hare', count = 1, weapon = 'Spear', knife = 'Knife', ...options }: any = {}) {
  const harvested = [];
  let failure = null;
  return runField(env, options, ['inventory', 'item_info', 'long_hand_hold', 'look_at', 'can_see', 'containers', 'sneak'], async field => {
    const search = new Search(field, {
      kind: `hunt:${match}`,
      match: [match],
      wanted: object =>
        object.kind === 'entity' &&
        object.alive !== false &&
        has(object, 'huntable') &&
        !has(object, 'hostile') &&
        !has(object, 'young') &&
        !has(object, 'player'),
      // Small prey can move sideways during the native spear wind-up. Get close
      // enough that a carefully tracked shot does not depend on predicting it.
      ready: object => object.alive !== false && object.visible && object.distance <= 5,
      score: (object, position) => horizontal(position, object.point),
      learn: objects =>
        learnYields(
          field,
          objects.filter(object => object.kind === 'entity').map(object => object.code),
        ),
      habitats: habitatsFor(match),
      take: async object => {
        if ((await countTool(field, weapon)) < 1) {
          failure = 'no_ranged_weapon';
          return false;
        }
        const shot = await throwAt(field, { target: object.key, expectedKind: match, weapon });
        if (!shot.killed) {
          if (!(await recoverProjectile(field, shot.weapon, shot.weaponCountBefore, shot.projectile))) failure = 'projectile_not_recovered';
          field.report('shot_did_not_kill', { target: object.key, code: object.code, targetVisible: shot.targetVisible });
          return false;
        }
        const result = await butcher(field, { target: object.key, expectedKind: match, knife });
        const recovered = await recoverProjectile(field, shot.weapon, shot.weaponCountBefore, shot.projectile);
        if (!result.ok) {
          failure = result.reason;
          return false;
        }
        if (!recovered) {
          failure = 'projectile_not_recovered';
          return false;
        }
        harvested.push({ target: object.key, code: object.code, items: 'items' in result ? result.items : [] });
        return true;
      },
    });
    await field.aim({ yawDegrees: field.heading, pitchDegrees: 0 });
    while (harvested.length < count) {
      await field.observe(true);
      if (failure)
        return { ok: false, reason: failure, goal: 'hunt', match, count, harvested, moved: +field.moved.toFixed(1), searched: field.searched };
      const evasion = await field.evadeThreat();
      if (evasion === 'blocked')
        return {
          ok: false,
          reason: 'threat_escape_blocked',
          goal: 'hunt',
          match,
          count,
          harvested,
          moved: +field.moved.toFixed(1),
          searched: field.searched,
        };
      if (evasion) {
        search.avoidThreat();
        continue;
      }
      if (search.pit || search.exhausted())
        return {
          ok: false,
          reason: search.pit ? 'pit' : 'none_found',
          goal: 'hunt',
          match,
          count,
          harvested,
          moved: +field.moved.toFixed(1),
          searched: field.searched,
        };
      field.report('searching', { match, count, harvested: harvested.length });
      await search.step();
    }
    return {
      ok: true,
      goal: 'hunt',
      match,
      count,
      harvested,
      moved: +field.moved.toFixed(1),
      searched: field.searched,
      verification: 'carcass_inventory_delta',
    };
  });
}

export default defineGoal({
  name: 'hunt',
  schema: z
    .object({
      match: z.string().min(1).max(64).default('hare').describe('Creature code substring; hare is the safe one-spear default.'),
      count: z.number().int().min(1).max(8).default(1),
      weapon: z.string().min(1).max(64).default('Spear').describe('Exact ranged inventory tool class.'),
      knife: z.string().min(1).max(64).default('Knife').describe('Exact butchering inventory tool class.'),
      sprint: z.boolean().optional(),
      timeoutMs: z.number().int().min(1000).max(3600000).optional(),
    })
    .strict(),
  destructive: true,
  description:
    'Search observed ground for an adult non-hostile creature the game explicitly tags as huntable, approach within a safe throw, ' +
    'verify line of sight, throw one ranged weapon, require the same entity to be observed dead, butcher it, transfer every ' +
    'carcass drop, and recover the landed weapon when visible. Uses the shared deterministic Search loop; no coordinates, ' +
    'screenshots, AI decisions or default deadline. The default is low-risk one-shot hare hunting. Returns START; poll goal_status.',
  title: args => `Hunt ${args.count} × ${cleanName(args.match)}`,
  announce: args => `Hunting ${cleanName(args.match)} for meat.`,
  run: hunt,
});
