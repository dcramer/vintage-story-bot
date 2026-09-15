import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { distance } from '../runtime/navigation/terrain.ts';
import { blockTarget } from '../runtime/schemas.ts';
import { parseBlockKey, selectCell } from '../support/blocks.ts';
import { equip, itemCount, ownedSlots } from '../support/inventory.ts';

import { cleanName, runField } from '../support/task.ts';

// Hold right-click on one observed block with the held (or requested) item; verify by block change or item consumption.
// expectDialog: a native dialog opening (controlReady false) is an expected effect, e.g. recipe selection after surface creation.
export type BlockUse = {
  target: string;
  face?: string;
  item?: string | null;
  quantity?: number;
  sneak?: boolean;
  holdMs?: number;
  expectAfter?: string;
  expectInfo?: string;
  consume?: boolean;
  expectDialog?: boolean;
};
export async function useOnBlock(
  field,
  { target, face, item, quantity = 1, sneak = false, holdMs = 600, expectAfter, expectInfo, consume = false, expectDialog = false }: BlockUse,
) {
  const cell = parseBlockKey(target);
  const state = await field.observe();
  if (holdMs > 2000 && !state.capabilities?.includes('long_hand_hold')) throw Error('Missing capability: long_hand_hold');
  if (cell.dimension !== state.position.dimension || distance(state.position, cell) > 8) throw Error('Target out of local reach; move closer first');
  let slot = state.activeSlot;
  if (item !== undefined) slot = (await equip(field, { item, quantity })).slot;
  const selected = await selectCell(field, cell, { face });
  if (!selected || selected.key !== target) throw Error('Target not in native reach, changed or obstructed; no action sent');
  await field.observe();
  let inventory = await field.send({ action: 'inventory' });
  let heldCode = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && s.slot === slot)?.code ?? null;
  if (item !== undefined && heldCode !== item) throw Error('Held item changed');
  let before = heldCode ? itemCount(inventory, heldCode) : 0;
  const beforeDetail = await field.send({ action: 'inspect_target' });
  const beforeInfo = typeof beforeDetail.info === 'string' ? beforeDetail.info : '';
  field.report('using', { target, item: heldCode, sneak });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await field.send({
          action: 'interact',
          durationMs: holdMs,
          expectedTarget: target,
          expectedState: inventory.state,
          expectedItem: { slot, code: heldCode },
          ...(sneak ? { sneak: true } : {}),
        });
        break;
      } catch (error) {
        // The bridge rejects before pressing the button when an asynchronous
        // inventory sync lands between our read and the guarded interaction.
        // One fresh guarded submission is safe; no game action was sent.
        if (attempt > 0 || !(error instanceof Error) || !/^Inventory changed; inspect before interacting\.$/i.test(error.message)) throw error;
        await field.observe(true);
        inventory = await field.send({ action: 'inventory' });
        heldCode = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && s.slot === slot)?.code ?? null;
        if (item !== undefined && heldCode !== item) throw Error('Held item changed');
        before = heldCode ? itemCount(inventory, heldCode) : 0;
        field.report('inventory_refreshed', { target, item: heldCode });
      }
    }
    const look = async () => {
      const state = await field.send({ action: 'observe' });
      return expectDialog && state.alive && !state.controlReady ? state : field.guard(state);
    };
    for (let i = 0; i < Math.ceil(holdMs / 200); i++) {
      await field.wait(200);
      await look();
    }
    await field.send({ action: 'stop' });
    let last;
    for (let i = 0; i < 10; i++) {
      const dialog = !(await look()).controlReady;
      const contents = await field.send({ action: 'inventory' });
      const consumed = heldCode ? before - itemCount(contents, heldCode) : 0;
      if (dialog) {
        last = { target, after: null, changed: null, consumed, item: heldCode, dialog: true };
        if (!consume || consumed > 0) return { ok: true, goal: 'use_block', ...last, verification: 'client_observed' };
        await field.wait(200);
        continue;
      }
      const detail = await field.send({ action: 'inspect_target' });
      const after = detail.key?.startsWith('block:') ? (detail.code ?? detail.key.split(':').slice(5).join(':')) : null;
      const info = typeof detail.info === 'string' ? detail.info : '';
      const changed = detail.key !== target;
      const infoChanged = info !== beforeInfo;
      last = { target, after, changed, consumed, item: heldCode, dialog: false, info, infoChanged };
      const expected =
        (expectAfter === undefined || (typeof after === 'string' && after.includes(expectAfter))) &&
        (expectInfo === undefined || info.includes(expectInfo)) &&
        (!consume || consumed > 0);
      if (expected && (changed || consumed > 0 || (expectInfo !== undefined && infoChanged)))
        return { ok: true, goal: 'use_block', ...last, verification: 'client_observed' };
      await field.wait(200);
    }
    return { ok: false, reason: 'no_observed_effect', ...last };
  } finally {
    await field.env.send({ action: 'stop' });
  }
}

export default defineGoal({
  name: 'use_block',
  schema: z
    .object({
      target: blockTarget,
      face: z.enum(['up', 'down', 'north', 'east', 'south', 'west']).optional().describe('Required block face for placement.'),
      item: z.string().min(1).max(160).nullable().optional().describe('Item code to equip first; null = empty hand; omitted = current slot.'),
      quantity: z.number().int().min(1).max(64).default(1).describe('Minimum requested stack size to equip, for multi-item interactions.'),
      sneak: z.boolean().default(false).describe('Shift modifier: ground storage, knapping/clay surface, firepit creation.'),
      holdMs: z.number().int().min(100).max(5000).default(600),
      expectAfter: z.string().min(1).max(64).optional().describe('Substring the target cell code must contain afterwards, e.g. farmland.'),
      expectInfo: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe('Substring the native target info must newly contain afterwards, for block-entity state such as a lit pit kiln.'),
      consume: z.boolean().default(false).describe('Require the held item count to drop.'),
      timeoutMs: z.number().int().min(1000).max(60000).default(20000),
    })
    .strict(),
  destructive: true,
  description:
    'Aim at one observed block within reach and hold right-click with the held item, optionally sneaking. quantity requests a sufficiently ' +
    'large held stack for interactions such as kiln layers. Verifies a target-cell ' +
    'code change, item consumption, or a requested target-info change (till, plant, water, ignite, ground placement, kiln layers); ' +
    'no_observed_effect otherwise. ' +
    'No walking, GUI dialogs or retries. Returns START; poll goal_status for client-observed outcome.',
  title: args => (args.item ? `Use ${cleanName(args.item)} on a block` : 'Use a block'),
  announce: args => `Working on a block${args.item ? ` with ${cleanName(args.item)}` : ''}.`,
  run: (env, options) => runField(env, options, ['inventory', 'sneak'], (field, _, o) => useOnBlock(field, o)),
});
