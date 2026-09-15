import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { equip, itemCount, ownedSlots } from '../support/inventory.ts';
import { cleanName, runField } from '../support/task.ts';

const entityTarget = z
  .string()
  .regex(/^entity:\d+$/)
  .describe('Visible living entity key from sightings.');

const findTarget = (field, target, expectedKind) =>
  field
    .scan(64, expectedKind, 'entities')
    .then(objects => objects.find(object => object.key === target && (!expectedKind || object.code.includes(expectedKind))));

export async function throwAt(field, { target, expectedKind, weapon = 'Spear', holdMs = 500 }) {
  let object = await findTarget(field, target, expectedKind);
  if (!object || object.alive === false) throw Error('Living target not currently visible or identity changed; scan again');
  const equipped = await equip(field, { tool: weapon });
  let inventory = await field.send({ action: 'inventory' });
  const held = ownedSlots(inventory).find(slot => slot.inventory === 'hotbar' && slot.slot === equipped.slot);
  if (!held?.code || held.tool !== weapon) throw Error('Ranged weapon selection unverified');
  const before = itemCount(inventory, held.code);

  field.report('aiming', { target, code: object.code, weapon: held.code });
  await field.send({ action: 'look_at', target });
  const locked = await field.until(
    state => {
      const current = state.nearbyEntities?.find(entity => entity.key === target);
      if (current) object = { ...object, ...current };
      return state.targetLock === target && current?.alive !== false && current?.visible !== false;
    },
    { timeoutMs: 2000, everyMs: 100 },
  );
  if (!locked.met) throw Error('Target could not be reacquired for a throw');
  const visible = await field.send({
    action: 'can_see',
    x: Math.floor(object.point.x),
    y: Math.floor(object.point.y),
    z: Math.floor(object.point.z),
  });
  if (!visible.known || !visible.visible) throw Error('Target is occluded; no throw sent');

  inventory = await field.send({ action: 'inventory' });
  const state = await field.observe();
  field.report('throwing', { target, code: object.code, weapon: held.code, distance: object.distance });
  await field.send({
    action: 'interact',
    durationMs: holdMs,
    expectedTarget: state.target?.key ?? null,
    expectedState: inventory.state,
    expectedItem: { slot: equipped.slot, code: held.code },
  });
  const launched = await field.until((_, contents) => itemCount(contents, held.code) <= before - 1, {
    timeoutMs: holdMs + 2000,
    everyMs: 100,
    read: () => field.send({ action: 'inventory' }),
  });
  if (!launched.met) throw Error('Throw was not observed in inventory; inspect before another attempt');

  let targetState = null;
  for (let reads = 0; reads < 20; reads++) {
    const after = await field.observe();
    targetState = after.nearbyEntities?.find(entity => entity.key === target) ?? targetState;
    if (targetState?.alive === false) break;
    await field.wait(100);
  }
  const projectiles = await field.scan(16, held.code, 'items');
  return {
    ok: true,
    goal: 'throw',
    target,
    targetCode: object.code,
    weapon: held.code,
    killed: targetState?.alive === false,
    targetVisible: targetState?.visible ?? false,
    projectile: projectiles[0]?.key ?? null,
    weaponCountBefore: before,
    weaponCountAfter: itemCount(launched.read, held.code),
    verification: 'inventory_delta',
  };
}

export default defineGoal({
  name: 'throw',
  schema: z
    .object({
      target: entityTarget,
      expectedKind: z.string().min(1).max(64).optional().describe('Entity code substring guard.'),
      weapon: z.string().min(1).max(64).default('Spear').describe('Exact inventory tool class.'),
      holdMs: z.number().int().min(350).max(2000).default(500),
      timeoutMs: z.number().int().min(1000).max(60000).optional(),
    })
    .strict(),
  destructive: true,
  description:
    'Equip a ranged weapon, continuously track one currently visible living entity, verify line of sight, hold right-click, ' +
    'and verify one weapon left inventory. Reports whether the same entity was then observed dead and the key of a visible ' +
    'landed projectile. No walking, target search or retry. No default deadline. Returns START; poll goal_status.',
  title: args => `Throw ${cleanName(args.weapon)} at ${cleanName(args.expectedKind ?? args.target)}`,
  announce: () => 'Taking a careful shot.',
  run: (env, options) => runField(env, options, ['inventory', 'look_at', 'can_see'], (field, _, o) => throwAt(field, o)),
});
