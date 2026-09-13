import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { ownedSlots } from '../support/inventory.ts';
import { shelterCover, supportedFloor, surfaceCover } from '../support/sites.ts';
import {
  SHELTER_MATERIAL,
  SHELTER_SIZE,
  shelter as shelterCells,
  shelterCenter,
  shelterDoor,
  shelterScaffold,
  shelterTorches,
} from '../support/structures.ts';
import { cleanName, runField } from '../support/task.ts';
import { build, digArea } from './build.ts';
import { lightShelter } from './light_shelter.ts';
import { travel } from './travel.ts';

// A complete dry footprint and a walkable doorway; unknown cells cannot support a home.
export function shelterSite(map, position) {
  const fits = origin => {
    for (let x = 0; x < SHELTER_SIZE; x++)
      for (let z = 0; z < SHELTER_SIZE; z++) {
        const floor = map.get(origin.x + x, origin.y - 1, origin.z + z);
        if (!supportedFloor(floor, origin.y)) return false;
        for (let h = 0; h <= 2; h++) {
          const cell = map.get(origin.x + x, origin.y + h, origin.z + z);
          if (!cell || cell.hazard || ((cell.boxes.length || (cell.code && cell.code !== 'game:air')) && !shelterCover(cell, h))) return false;
        }
      }
    return (
      !!map.nodeAt(origin.x + 2, origin.z + SHELTER_SIZE, origin.y, 0.6, 0.1) &&
      !!map.nodeAt(origin.x + 1, origin.z + SHELTER_SIZE, origin.y, 0.6, 0.1) &&
      !!map.nodeAt(origin.x + 1, origin.z + SHELTER_SIZE + 1, origin.y, 0.6, 0.1)
    );
  };
  const distance = origin => Math.hypot(origin.x + 2.5 - position.x, (origin.y - position.y) * 2, origin.z + 2.5 - position.z);
  const candidates = [];
  for (const y of [0, 1, -1, 2, -2].map(dy => Math.floor(position.y) + dy))
    for (let dx = -5; dx <= 5; dx++)
      for (let dz = -5; dz <= 5; dz++) {
        const origin = { x: Math.floor(position.x) + dx, y, z: Math.floor(position.z) + dz };
        if (fits(origin)) candidates.push(origin);
      }
  if (candidates.length) return candidates.sort((a, b) => distance(a) - distance(b))[0];

  // Revisit observed ground before exploring again. Test every candidate in
  // range: a nearest-candidate cap can hide the only flat patch behind slopes.
  let remembered = null;
  let nearest = Infinity;
  for (const cell of map.cells?.values?.() ?? []) {
    if (Math.hypot(cell.x + 2.5 - position.x, cell.z + 2.5 - position.z) > 256 || Math.abs(cell.y + 1 - position.y) > 32) continue;
    if (!supportedFloor(cell, cell.y + 1)) continue;
    const above = map.get(cell.x, cell.y + 1, cell.z);
    if (!above || above.hazard || ((above.boxes.length || (above.code && above.code !== 'game:air')) && !shelterCover(above, 0))) continue;
    const origin = { x: cell.x, y: cell.y + 1, z: cell.z };
    const near = distance(origin);
    if (near >= nearest || !fits(origin)) continue;
    remembered = origin;
    nearest = near;
  }
  return remembered;
}

// Four walls before dark: build the starter shelter beside where the bot stands,
// walk in, seal the door from inside, light it. The spot becomes home.
export default defineGoal({
  name: 'shelter',
  schema: z
    .object({
      origin: z
        .object({ x: z.number().int(), y: z.number().int(), z: z.number().int() })
        .strict()
        .optional()
        .describe('Resume an owned partial shelter at this origin.'),
      item: z.string().min(1).max(160).default(SHELTER_MATERIAL).describe('Carried block item code substring for the walls.'),
      torch: z.boolean().default(true).describe('Light the interior torch once sealed in; bring a torch and a firestarter if it is unlit.'),
      manageFood: z.boolean().default(false),
      timeoutMs: z.number().int().min(1000).max(3600000).default(1800000),
    })
    .strict(),
  destructive: true,
  description:
    'Build the starter shelter (5x5, 3x3 interior, walls 2 high, flat roof, 57 shell blocks plus three front stair blocks) on nearby observed level ground, walk in, seal the ' +
    'door from inside and light the interior torch. Two stair rises keep the roof accessible while building. Fails fast with not_enough_material; walls, cannot_enter and seal ' +
    'report which phase stopped. Result home is the spot to return to. Returns START; poll goal_status.',
  title: args => `Build a ${cleanName(args.item)} shelter`,
  announce: args => `Putting up a little ${cleanName(args.item)} shelter.`,
  run: (env, { origin: planned, item, torch, ...options }) =>
    runField(env, options, ['inventory', 'block_actions', 'sneak'], async (field, survival) => {
      const origin = planned ?? shelterSite(field.env.map, field.latest.position);
      if (!origin) return { ok: false, goal: 'shelter', reason: 'no_level_site' };
      const existing = cell => {
        const block = field.env.map.get(cell.x, cell.y, cell.z);
        return block?.boxes.length && block.code?.includes(item) ? block.code : null;
      };
      const slots = ownedSlots(await field.send({ action: 'inventory' })) as any[];
      // Every variant of the material counts, and each cell takes the variant with the most left.
      const stock = new Map<string, number>();
      for (const s of slots) if (s.code?.includes(item)) stock.set(s.code, (stock.get(s.code) ?? 0) + s.quantity);
      const have = [...stock.values()].reduce((n, q) => n + q, 0);
      const scaffold = shelterScaffold(origin, item);
      const need = [...scaffold, ...shelterCells(origin, item), ...shelterDoor(origin, item)].filter(cell => !existing(cell)).length;
      if (have < need) return { ok: false, goal: 'shelter', reason: 'not_enough_material', item, have, need, origin };
      const supply = [...stock.entries()].sort((a, b) => b[1] - a[1]);
      const assign = cells =>
        cells.map(cell => {
          const code = existing(cell);
          if (code) return { ...cell, item: code };
          while (supply.length > 1 && supply[0][1] <= 0) supply.shift();
          supply[0][1]--;
          return { ...cell, item: supply[0][0] };
        });
      const center = shelterCenter(origin);
      const home = { x: center.x, y: origin.y, z: center.z };
      const cover = [];
      for (let x = 0; x < SHELTER_SIZE; x++)
        for (let z = 0; z < SHELTER_SIZE; z++)
          for (let h = 0; h <= 2; h++) {
            const cell = { x: origin.x + x, y: origin.y + h, z: origin.z + z };
            if (shelterCover(field.env.map.get(cell.x, cell.y, cell.z), h)) cover.push(cell);
          }
      const outside = { x: origin.x + 2, y: origin.y, z: origin.z + SHELTER_SIZE };
      if (surfaceCover(field.env.map.get(outside.x, outside.y, outside.z))) cover.push(outside);
      for (const cell of scaffold) if (shelterCover(field.env.map.get(cell.x, cell.y, cell.z), cell.y - origin.y)) cover.push(cell);
      if (cover.length) {
        field.report('clearing_site', { origin });
        const cleared = await digArea(field, survival, { cells: cover, tool: undefined });
        if (!cleared.ok) return { ...cleared, goal: 'shelter', phase: 'site', origin };
      }
      field.report('walls', { origin });
      const walls: any = await build(field, survival, { cells: assign([...scaffold, ...shelterCells(origin, item)]), verifyExisting: true });
      if (!walls.ok) return { ok: false, goal: 'shelter', reason: walls.reason ?? 'walls', phase: 'walls', origin, walls };
      field.report('entering', { origin });
      const entered = await travel(field, survival, { ...home, arrivalRadius: 0.35 });
      if (!entered.ok) return { ok: false, goal: 'shelter', reason: 'cannot_enter', phase: 'enter', origin, travel: entered };
      field.report('sealing', { origin });
      const seal: any = await build(field, survival, { cells: assign(shelterDoor(origin, item)) });
      if (!seal.ok) return { ok: false, goal: 'shelter', reason: seal.reason ?? 'seal', phase: 'seal', origin, seal };
      let lit = false;
      if (torch) {
        const lighting = await lightShelter(field, survival, { cells: shelterTorches(origin) });
        if (!lighting.ok) return { ...lighting, goal: 'shelter', phase: 'lighting', origin, home };
        lit = true;
      }
      return { ok: true, goal: 'shelter', origin, home, item, placed: walls.placed + seal.placed, lit, verification: 'client_observed' };
    }),
});
