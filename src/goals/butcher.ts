import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { distance, horizontal } from '../runtime/navigation/terrain.ts';
import { equip, ownedSlots } from '../support/inventory.ts';
import { cleanName, runField } from '../support/task.ts';
import { closeContainer, moveItems } from './store_items.ts';

const entityTarget = z
  .string()
  .regex(/^entity:\d+$/)
  .describe('Visible dead creature key from sightings.');

async function corpse(field, target, expectedKind) {
  const objects = await field.scan(64, expectedKind, 'entities');
  return objects.find(object => object.key === target && (!expectedKind || object.code.includes(expectedKind)));
}

async function openCarcass(field, target) {
  // Harvesting already opened this dialog. Adopt it once; never replay a
  // container mutation after an ambiguous refusal.
  const result = await field.env.send({ action: 'open_container', target });
  if (!result.ok) throw Error(result.error ?? 'Carcass contents did not open');
  return { ...result, target };
}

export async function butcher(field, { target, expectedKind, knife = 'Knife' }) {
  let object = await corpse(field, target, expectedKind);
  if (object?.alive !== false) throw Error('Dead creature not currently visible or identity changed; scan again');
  for (let legs = 0; ; legs++) {
    const state = await field.observe(true);
    const eye = { ...state.position, y: state.position.y + state.body.eyeHeight };
    if (distance(eye, object.point) <= state.pickingRange - 0.2) break;
    if (legs >= 8) return { ok: false, reason: 'carcass_unreachable', target };
    const destination = field.approach(object) ?? (horizontal(state.position, object.point) > 6 ? field.explore(object.point, 24) : null);
    if (!destination) return { ok: false, reason: 'no_carcass_standing_spot', target };
    const result = await field.walk(destination);
    if (!['arrived', 'paused'].includes(result.state) && legs >= 3) return { ok: false, reason: result.reason ?? 'carcass_route_blocked', target };
    object = (await corpse(field, target, expectedKind)) ?? object;
  }

  const equipped = await equip(field, { tool: knife });
  let inventory = await field.send({ action: 'inventory' });
  const held = ownedSlots(inventory).find(slot => slot.inventory === 'hotbar' && slot.slot === equipped.slot);
  if (!held?.code || held.tool !== knife) throw Error('Knife selection unverified');
  await field.send({ action: 'look_at', target });
  const selected = await field.until(state => state.targetLock === target && state.target?.key === target, {
    timeoutMs: 2000,
    everyMs: 100,
  });
  if (!selected.met) throw Error('Carcass could not be selected within reach');
  const detail = await field.send({ action: 'inspect_target' });
  if (detail.key !== target || detail.alive !== false) throw Error('Target is not a dead creature; no harvest sent');

  inventory = await field.send({ action: 'inventory' });
  field.report('butchering', { target, code: object.code, knife: held.code });
  await field.send({
    action: 'interact',
    durationMs: 5000,
    sneak: true,
    expectedTarget: target,
    expectedState: inventory.state,
    expectedItem: { slot: equipped.slot, code: held.code },
  });
  // Harvest completion opens the native carcass inventory itself. That dialog
  // intentionally releases mouse capture, so keep guarding life/session while
  // allowing the expected temporary loss of world controls.
  for (let elapsed = 0; elapsed < 5250; elapsed += 250) {
    await field.wait(250);
    field.assess(await field.env.send({ action: 'observe' }), { controls: false });
  }
  await field.env.send({ action: 'stop' });

  const container = await openCarcass(field, target);
  try {
    let view = container;
    for (let reads = 0; reads < 10 && !(view.slots ?? []).some(slot => slot.code); reads++) {
      await field.wait(200);
      view = { ...(await field.send({ action: 'container_slots' })), target };
    }
    const codes = [...new Set((view.slots ?? []).map(slot => slot.code).filter(Boolean))];
    if (!codes.length) return { ok: false, reason: 'carcass_harvest_unverified', target };
    const items = [];
    for (const item of codes) {
      view = { ...(await field.send({ action: 'container_slots' })), target };
      items.push({ item, ...(await moveItems(field, { container: view, item, direction: 'take' })) });
    }
    const failed = items.find(item => item.reason);
    return {
      ok: !failed,
      goal: 'butcher',
      ...(failed ? { reason: failed.reason } : {}),
      target,
      targetCode: object.code,
      items,
      verification: 'inventory_delta',
    };
  } finally {
    await closeContainer(field).catch(() => {});
  }
}

export default defineGoal({
  name: 'butcher',
  schema: z
    .object({
      target: entityTarget,
      expectedKind: z.string().min(1).max(64).optional().describe('Creature code substring guard.'),
      knife: z.string().min(1).max(64).default('Knife').describe('Exact inventory tool class.'),
      sprint: z.boolean().optional(),
      timeoutMs: z.number().int().min(1000).max(300000).optional(),
    })
    .strict(),
  destructive: true,
  description:
    'Approach one visible dead creature, equip a knife, sneak-harvest it for the native duration, open the carcass inventory, ' +
    'and transfer every drop through the normal inventory path. Verifies death, target identity and each inventory delta. ' +
    'No target search or default deadline. Returns START; poll goal_status.',
  title: args => `Butcher ${cleanName(args.expectedKind ?? args.target)}`,
  announce: () => 'Harvesting a carcass.',
  run: (env, options) =>
    runField(env, options, ['inventory', 'long_hand_hold', 'look_at', 'containers', 'sneak'], (field, _, o) => butcher(field, o)),
});
