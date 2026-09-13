import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { ownedSlots } from '../support/inventory.ts';
import { runField } from '../support/task.ts';
import { build, digArea } from './build.ts';
import { travel } from './travel.ts';

const cell = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict();

export default defineGoal({
  name: 'enter_shelter',
  schema: z
    .object({
      door: cell,
      home: z.object({ x: z.number(), y: z.number(), z: z.number() }).strict(),
      item: z.string().min(1).max(160),
      timeoutMs: z.number().int().min(1000).max(3600000).default(600000),
    })
    .strict(),
  destructive: true,
  description:
    'Open the two-block seal of an owned shelter, walk inside, and rebuild the seal from carried material. Verify entry and sealing. Returns START; poll goal_status.',
  title: () => 'Enter and seal shelter',
  announce: () => 'Going inside and closing the shelter.',
  run: (env, { door, home, item, ...options }) =>
    runField(env, options, ['inventory', 'block_actions'], async (field, survival) => {
      const cells = [door, { ...door, y: door.y + 1 }];
      const slots = ownedSlots(await field.send({ action: 'inventory' }));
      const have = slots.filter(s => s.code?.includes(item)).reduce((n, s) => n + s.quantity, 0);
      if (have < 2) return { ok: false, goal: 'enter_shelter', reason: 'not_enough_material', have, need: 2 };
      const p = field.latest.position;
      if (Math.hypot(p.x - home.x, p.z - home.z) > 3) {
        const approached = await travel(field, survival, { x: door.x + 0.5, y: door.y, z: door.z + 1.5, arrivalRadius: 0.6 });
        if (!approached.ok) return { ...approached, goal: 'enter_shelter', phase: 'approach' };
      }
      const opened = await digArea(field, survival, { cells, tool: undefined });
      if (!opened.ok) return { ...opened, goal: 'enter_shelter', phase: 'open' };
      const entered = await travel(field, survival, { ...home, arrivalRadius: 0.35 });
      if (!entered.ok) return { ...entered, goal: 'enter_shelter', phase: 'enter' };
      const sealed = await build(field, survival, { cells: cells.map(c => ({ ...c, item })) });
      return { ...sealed, goal: 'enter_shelter', phase: 'seal', home, verification: 'client_observed' };
    }),
});
