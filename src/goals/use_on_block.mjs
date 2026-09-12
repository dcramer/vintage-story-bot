import { z } from 'zod';
import { defineGoal } from '../runtime/define.mjs';
import { distance } from '../runtime/navigation/terrain.mjs';
import { blockTarget } from '../runtime/schemas.mjs';
import { parseBlockKey, selectCell } from '../support/blocks.mjs';
import { equip, itemCount, ownedSlots } from '../support/inventory.mjs';

import { cleanName, runField } from '../support/task.mjs';

// Hold right-click on one observed block with the held (or requested) item; verify by block change or item consumption.
// expectDialog: a native dialog opening (controlReady false) is an expected effect, e.g. recipe selection after surface creation.
export async function useOnBlock(field, { target, item, sneak = false, holdMs = 600, expectAfter, consume = false, expectDialog = false }) {
  const cell = parseBlockKey(target);
  const state = await field.observe();
  if (cell.dimension !== state.position.dimension || distance(state.position, cell) > 8) throw Error('Target out of local reach; move closer first');
  let slot = state.activeSlot;
  if (item !== undefined) slot = (await equip(field, { item })).slot;
  const selected = await selectCell(field, cell);
  if (!selected || selected.key !== target) throw Error('Target not in native reach, changed or obstructed; no action sent');
  await field.observe();
  const inventory = await field.send({ action: 'inventory' });
  const held = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && s.slot === slot);
  const heldCode = held?.code ?? null;
  if (item !== undefined && heldCode !== item) throw Error('Held item changed');
  const before = heldCode ? itemCount(inventory, heldCode) : 0;
  field.report('using', { target, item: heldCode, sneak });
  try {
    await field.send({ action: 'interact', durationMs: holdMs, expectedTarget: target, expectedState: inventory.state,
      expectedItem: { slot, code: heldCode }, ...(sneak ? { sneak: true } : {}) });
    const look = async () => {
      const state = await field.send({ action: 'observe' });
      return expectDialog && state.alive && !state.controlReady ? state : field.guard(state);
    };
    for (let i = 0; i < Math.ceil(holdMs / 200); i++) { await field.wait(200); await look(); }
    await field.send({ action: 'stop' });
    let last;
    for (let i = 0; i < 10; i++) {
      const dialog = !(await look()).controlReady;
      const contents = await field.send({ action: 'inventory' });
      const consumed = heldCode ? before - itemCount(contents, heldCode) : 0;
      if (dialog) {
        last = { target, after: null, changed: null, consumed, item: heldCode, dialog: true };
        if (!consume || consumed > 0) return { ok: true, goal: 'use_on_block', ...last, verification: 'client_observed' };
        await field.wait(200);
        continue;
      }
      const detail = await field.send({ action: 'inspect_target' });
      const after = detail.key?.startsWith('block:') ? detail.code ?? detail.key.split(':').slice(5).join(':') : null;
      const changed = detail.key !== target;
      last = { target, after, changed, consumed, item: heldCode, dialog: false };
      const expected = (expectAfter === undefined || typeof after === 'string' && after.includes(expectAfter)) && (!consume || consumed > 0);
      if (expected && (changed || consumed > 0 || expectAfter !== undefined))
        return { ok: true, goal: 'use_on_block', ...last, verification: 'client_observed' };
      await field.wait(200);
    }
    return { ok: false, reason: 'no_observed_effect', ...last };
  } finally {
    await field.env.send({ action: 'stop' });
  }
}

export default defineGoal({
  name: 'use_on_block',
  schema: z.object({
    target: blockTarget,
    item: z.string().min(1).max(160).nullable().optional().describe('Item code to equip first; null = empty hand; omitted = current slot.'),
    sneak: z.boolean().default(false).describe('Shift modifier: ground storage, knapping/clay surface, firepit creation.'),
    holdMs: z.number().int().min(100).max(2000).default(600),
    expectAfter: z.string().min(1).max(64).optional().describe('Substring the target cell code must contain afterwards, e.g. farmland.'),
    consume: z.boolean().default(false).describe('Require the held item count to drop.'),
    timeoutMs: z.number().int().min(1000).max(60000).default(20000),
  }).strict(),
  destructive: true,
  description:
    'Aim at one observed block within reach and hold right-click with the held item, optionally sneaking. Verifies a target-cell ' +
    'code change or item consumption (till, plant, water, ignite, ground placement, kiln layers); no_observed_effect otherwise. ' +
    'No walking, GUI dialogs or retries. Returns START; poll goal_status for client-observed outcome.',
  announce: args => `Working on a block${args.item ? ` with ${cleanName(args.item)}` : ''}.`,
  run: (env, options) => runField(env, options, ['inventory', 'sneak'], (field, _, o) => useOnBlock(field, o)),
});
