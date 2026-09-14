import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { selectCell } from '../support/blocks.ts';
import { ignite } from '../support/fire.ts';
import { Gleaner } from '../support/gleaning.ts';
import { ownedSlots } from '../support/inventory.ts';
import { runField } from '../support/task.ts';
import { build, digArea } from './build.ts';

// What a shelter cell needs from what stands there: a lit torch is only
// replaced on refresh, resetting its burn clock; an extinguished one relights
// where it stands; a burnt-out one is always cleared (it drops nothing and
// cannot be relit) and replaced.
export function torchCellPlan(code: string | null | undefined, refresh: boolean): 'ok' | 'ignite' | 'place' | 'replace' {
  if (!code || code === 'game:air' || !code.includes('torch-basic-')) return 'place';
  if (code.includes('torch-basic-burnedout-')) return 'replace';
  if (code.includes('torch-basic-lit-')) return refresh ? 'replace' : 'ok';
  return 'ignite';
}

export async function lightShelter(field, survival, { cells, refresh = false }) {
  for (const cell of cells) {
    let selected = await selectCell(field, cell);
    if (torchCellPlan(selected?.code, refresh) === 'replace') {
      const burnedout = !!selected?.code?.includes('torch-basic-burnedout-');
      let held = 0;
      if (!burnedout) {
        const before = ownedSlots(await field.send({ action: 'inventory' }));
        if (!before.some(s => !s.bag && !s.code) && !before.some(s => s.code?.includes('torch-basic') && s.quantity < 64))
          return { ok: false, goal: 'light_shelter', reason: 'no_room_for_recovered_torch' };
        const count = slots => slots.filter(s => s.code?.includes('torch-basic')).reduce((n, s) => n + s.quantity, 0);
        held = count(before);
      }
      const removed = await digArea(field, survival, { cells: [cell], tool: undefined });
      if (!removed.ok) return { ...removed, goal: 'light_shelter' };
      if (!burnedout) {
        const count = slots => slots.filter(s => s.code?.includes('torch-basic')).reduce((n, s) => n + s.quantity, 0);
        await new Gleaner(field, ['torch-basic']).tend(1);
        const recovered = await field.until((_, inventory) => count(ownedSlots(inventory)) > held, {
          timeoutMs: 2000,
          everyMs: 200,
          read: () => field.send({ action: 'inventory' }),
        });
        if (!recovered.met) return { ok: false, goal: 'light_shelter', reason: 'torch_pickup_unverified' };
      }
      selected = null;
    }
    if (!selected?.key.includes(':game:torch-basic-')) {
      const slots = ownedSlots(await field.send({ action: 'inventory' }));
      const torch = slots.find(s => s.code?.includes('torch-basic'));
      if (!torch) return { ok: false, goal: 'light_shelter', reason: 'no_torch' };
      const placed = await build(field, survival, { cells: [{ ...cell, item: torch.code }] });
      if (!placed.ok) return { ...placed, goal: 'light_shelter' };
      selected = await selectCell(field, cell);
    }
    if (!selected?.key.includes(':game:torch-basic-')) return { ok: false, goal: 'light_shelter', reason: 'torch_not_observed' };
    if (!selected.key.includes('torch-basic-lit-')) {
      const lit = await ignite(field, {
        target: selected.key,
        holdMs: 2000,
        lit: 'torch-basic-lit-',
      });
      if (!lit.ok) return { ...lit, goal: 'light_shelter' };
    }
  }
  return { ok: true, goal: 'light_shelter', verification: 'client_observed', cells };
}

export default defineGoal({
  name: 'light_shelter',
  schema: z
    .object({
      cells: z
        .array(z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict())
        .min(1)
        .max(2),
      refresh: z.boolean().default(false),
      timeoutMs: z.number().int().min(1000).max(300000).default(180000),
    })
    .strict(),
  destructive: true,
  description:
    'Light one or two owned shelter cells with a firestarter: extinguished torches relight in place, empty cells take a carried torch, burnt-out torches are cleared (they drop nothing) and replaced. Refresh also replaces lit torches to reset their burn clock, verifying recovery. Returns START; poll goal_status.',
  title: () => 'Light the shelter',
  announce: () => 'Lighting the shelter.',
  run: (env, { cells, refresh, ...options }) =>
    runField(env, options, ['inventory', 'block_actions', 'sneak'], (field, survival) => lightShelter(field, survival, { cells, refresh })),
});
