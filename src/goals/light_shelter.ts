import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { selectCell } from '../support/blocks.ts';
import { ignite } from '../support/fire.ts';
import { ownedSlots } from '../support/inventory.ts';
import { runField } from '../support/task.ts';
import { build, digArea } from './build.ts';

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
    'Place carried torches at one or two owned shelter cells and light each with a firestarter. Refresh removes existing torches before replacing them with carried ones. Verify lit block codes. Returns START; poll goal_status.',
  title: () => 'Light the shelter',
  announce: () => 'Lighting the shelter.',
  run: (env, { cells, refresh, ...options }) =>
    runField(env, options, ['inventory', 'block_actions', 'sneak'], async (field, survival) => {
      const carried = ownedSlots(await field.send({ action: 'inventory' }));
      if (refresh && carried.filter(s => s.code?.includes('torch-basic')).reduce((n, s) => n + s.quantity, 0) < cells.length)
        return { ok: false, goal: 'light_shelter', reason: 'not_enough_torches' };
      for (const cell of cells) {
        let selected = await selectCell(field, cell);
        if (selected?.key.includes(':game:torch-basic-') && refresh) {
          const removed = await digArea(field, survival, { cells: [cell], tool: undefined });
          if (!removed.ok) return { ...removed, goal: 'light_shelter' };
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
    }),
});
