import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { blockTarget } from '../runtime/schemas.ts';
import { parseBlockKey, selectCell } from '../support/blocks.ts';
import { learn } from '../support/facts.ts';
import { ignite } from '../support/fire.ts';
import { edible } from '../support/food.ts';
import { equip } from '../support/inventory.ts';
import { cleanName, runField } from '../support/task.ts';
import { closeContainer, moveItems, openContainer } from './store_items.ts';

export function handAfterIgnition(hotbar, hand) {
  if (hand !== 'game:firestarter') return hand;
  const ordinary = hotbar.filter(slot => slot.slot < 10);
  if (ordinary.some(slot => !slot.code)) return null;
  return ordinary.find(slot => slot.code && slot.code !== 'game:firestarter')?.code;
}

// Firepit slots are the native fuel/input/output slots, not interchangeable storage.
export async function cook(field, { target, item, count, fuel }) {
  const cell = parseBlockKey(target);
  const summary = extra => ({ goal: 'cook', item, count, cell, ...extra });
  if (!/:game:firepit-(cold|extinct|lit)$/.test(target)) return summary({ ok: false, reason: 'not_a_finished_firepit' });
  const page = await learn(field, item);
  const output = page?.combustible?.smeltsInto;
  if (!output || page.combustible.smeltedRatio !== 1 || !edible((await learn(field, output))?.nutrition))
    return summary({ ok: false, reason: 'no_edible_cooking_output' });
  await field.observe();
  const overlaps = point =>
    Math.abs(point.x - cell.x - 0.5) < 0.5 + field.latest.body.halfWidth + 0.15 &&
    Math.abs(point.z - cell.z - 0.5) < 0.5 + field.latest.body.halfWidth + 0.15;
  if (overlaps(field.latest.position)) {
    // A cold firepit can be walked through. Step clear before lighting it;
    // leave room for the navigator's arrival tolerance around the body.
    const stand = field.approach(
      { kind: 'block', point: { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 } },
      point => Math.abs(point.x - cell.x - 0.5) < 1.5 && Math.abs(point.z - cell.z - 0.5) < 1.5,
    );
    if (!stand) return summary({ ok: false, reason: 'no_safe_cooking_position' });
    await field.walk(stand);
    await field.observe();
    if (overlaps(field.latest.position)) return summary({ ok: false, reason: 'no_safe_cooking_position' });
  }
  let opened = false;
  let moved = 0;
  const open = async () => {
    // A nearby grass tuft can intercept the ray to the low firepit even though
    // the eye just observed the firepit itself. Clear that ordinary visual
    // obstruction before concluding the owned firepit disappeared.
    const selected = await selectCell(field, cell, { clearPlants: true });
    if (!selected || !/:game:firepit-(cold|extinct|lit)$/.test(selected.key)) throw Error('Firepit not observed');
    const container = await openContainer(field, { target: selected.key });
    opened = true;
    return container;
  };
  const close = async () => {
    await closeContainer(field);
    opened = false;
  };
  try {
    let container = await open();
    const slot = n => container.slots.find(s => s.slot === n);
    if ([0, 1, 2].some(n => !slot(n))) return summary({ ok: false, reason: 'firepit_slots_missing' });
    if ((slot(0).code && slot(0).code !== 'game:firewood') || (slot(1).code && slot(1).code !== item) || (slot(2).code && slot(2).code !== output))
      return summary({ ok: false, reason: 'incompatible_contents' });
    if (slot(2).quantity >= count) {
      const result = await moveItems(field, { container, item: output, count, direction: 'take', containerSlots: [2] });
      return summary({ ok: !result.reason, ...result, output, verification: 'inventory_delta' });
    }
    const wantedInput = Math.max(0, count - slot(1).quantity - slot(2).quantity);
    const wantedFuel = Math.max(0, fuel - slot(0).quantity);
    // Load food first: a smoldering firepit may immediately burn new fuel.
    for (const load of [
      { slot: 1, item, count: wantedInput },
      { slot: 0, item: 'game:firewood', count: wantedFuel },
    ]) {
      if (!load.count) continue;
      const result = await moveItems(field, {
        container,
        item: load.item,
        count: load.count,
        direction: 'store',
        containerSlots: [load.slot],
        allowConsumption: true,
      });
      if (result.reason) {
        if (load.slot === 0 && result.reason === 'transfer_unverified') {
          // Do not resend an uncertain transfer. If the fire is visibly lit,
          // wait for the already verified input to cook; output still needs
          // its own paired inventory verification before this goal succeeds.
          await close();
          const burning = await selectCell(field, cell);
          if (burning?.key.endsWith(':game:firepit-lit')) {
            field.report('fuel_burning', { transfer: 'unverified' });
            break;
          }
        }
        return summary({ ok: false, reason: result.reason, phase: 'loading', slot: load.slot });
      }
      container = await field.send({ action: 'container_slots' });
    }
    if (opened) await close();
    const selected = await selectCell(field, cell);
    if (!selected) return summary({ ok: false, reason: 'firepit_not_observed' });
    if (!selected.key.endsWith(':game:firepit-lit')) {
      const hand = field.latest.hotbar.find(s => s.slot === field.latest.activeSlot)?.code ?? null;
      const lit = await ignite(field, {
        target: selected.key,
        holdMs: 4000,
        lit: 'game:firepit-lit',
      });
      if (!lit.ok) return summary({ ok: false, reason: 'ignition_unverified', detail: lit });
      // Put away the firestarter before the click that opens the hot firepit.
      const nextHand = handAfterIgnition(field.latest.hotbar, hand);
      if (nextHand !== undefined) await equip(field, { item: nextHand });
    }
    container = await open();
    while (moved < count) {
      await field.wait(1000);
      field.assess(await field.send({ action: 'observe' }), { controls: false });
      container = await field.send({ action: 'container_slots' });
      const ready = container.slots.find(s => s.slot === 2 && s.code === output);
      if (ready?.quantity > 0) {
        const result = await moveItems(field, {
          container,
          item: output,
          count: Math.min(ready.quantity, count - moved),
          direction: 'take',
          containerSlots: [2],
        });
        moved += result.moved;
        if (result.reason) return summary({ ok: false, reason: result.reason, moved, output });
      }
      field.report('cooking', { item, output, count, moved });
    }
    return summary({ ok: true, moved, output, verification: 'inventory_delta' });
  } finally {
    if (opened) await closeContainer(field).catch(() => {});
  }
}

export default defineGoal({
  name: 'cook',
  schema: z
    .object({
      target: blockTarget.describe('Owned finished firepit within picking range; compatible existing contents can resume.'),
      item: z.string().min(1).max(160).describe('Exact raw item code whose handbook cooking output is edible.'),
      count: z.number().int().min(1).max(8).default(1),
      fuel: z.number().int().min(1).max(32).default(8).describe('Firewood to have in the fuel slot before lighting.'),
      timeoutMs: z.number().int().min(5000).max(1200000).default(600000),
    })
    .strict(),
  destructive: true,
  description:
    'Cook simple foods in an owned firepit: load native fuel/input slots, ignite with a carried firestarter, wait for cooked output, ' +
    'and retrieve it with verified inventory transfers. No pots or meals. Stops on incompatible contents or unverified effects. Returns START; poll goal_status.',
  title: args => `Cook ${cleanName(args.item)}`,
  announce: args => `Cooking ${cleanName(args.item)}.`,
  run: (env, options) => runField(env, options, ['inventory', 'containers', 'item_info', 'long_hand_hold', 'sneak'], field => cook(field, options)),
});
