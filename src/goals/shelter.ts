import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { ownedSlots } from '../support/inventory.ts';
import { shelter as shelterCells, shelterCenter, shelterDoor } from '../support/structures.ts';
import { cleanName, runField } from '../support/task.ts';
import { build } from './build.ts';
import { travel } from './travel.ts';

// Four walls before dark: build the tiny shelter beside where the bot stands,
// walk in, seal the door from inside, light it. The spot becomes home.
export default defineGoal({
  name: 'shelter',
  schema: z
    .object({
      item: z.string().min(1).max(160).default('soil-').describe('Carried block item code substring for the walls.'),
      torch: z.boolean().default(true).describe('Place a carried torch on the floor once sealed in.'),
      manageFood: z.boolean().default(false),
      timeoutMs: z.number().int().min(1000).max(3600000).default(1800000),
    })
    .strict(),
  destructive: true,
  description:
    'Build the tiny shelter (3x3, walls 2 high, flat roof, 25 blocks) two blocks from where the bot stands, walk in, seal the ' +
    'door from inside and place a torch if one is carried. Fails fast with not_enough_material; walls, cannot_enter and seal ' +
    'report which phase stopped. Result home is the spot to return to. Returns START; poll goal_status.',
  announce: args => `Putting up a little ${cleanName(args.item)} shelter.`,
  run: (env, { item, torch, ...options }) =>
    runField(env, options, ['inventory', 'block_actions'], async (field, survival) => {
      const slots = ownedSlots(await field.send({ action: 'inventory' })) as any[];
      const code = slots.find(s => s.code?.includes(item))?.code;
      const have = slots.filter(s => s.code === code).reduce((n, s) => n + s.quantity, 0);
      const need = 25;
      if (!code || have < need) return { ok: false, goal: 'shelter', reason: 'not_enough_material', item, have, need };
      const p = field.latest.position;
      const origin = { x: Math.floor(p.x) + 2, y: Math.floor(p.y), z: Math.floor(p.z) - 1 };
      const center = shelterCenter(origin);
      const home = { x: center.x, y: origin.y, z: center.z };
      field.report('walls', { origin });
      const walls: any = await build(field, survival, { cells: shelterCells(origin, code) });
      if (!walls.ok) return { ok: false, goal: 'shelter', reason: walls.reason ?? 'walls', phase: 'walls', origin, walls };
      field.report('entering', { origin });
      const entered = await travel(field, survival, { x: center.x, z: center.z, arrivalRadius: 0.5 });
      if (!entered.ok) return { ok: false, goal: 'shelter', reason: 'cannot_enter', phase: 'enter', origin, travel: entered };
      field.report('sealing', { origin });
      const seal: any = await build(field, survival, { cells: shelterDoor(origin, code) });
      if (!seal.ok) return { ok: false, goal: 'shelter', reason: seal.reason ?? 'seal', phase: 'seal', origin, seal };
      let lit = false;
      const torchCode = torch ? slots.find(s => s.code?.includes('torch-basic'))?.code : null;
      if (torchCode) {
        field.report('lighting', { origin });
        lit = (await build(field, survival, { cells: [{ x: origin.x + 1, y: origin.y, z: origin.z + 1, item: torchCode }] })).ok;
      }
      return { ok: true, goal: 'shelter', origin, home, placed: walls.placed + seal.placed, lit, verification: 'client_observed' };
    }),
});
