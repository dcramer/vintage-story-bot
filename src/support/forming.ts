import { useOnBlock } from '../goals/use_block.ts';
import { lookAt, normalize } from '../runtime/navigation/terrain.ts';
import { parseBlockKey, replaceablePlant } from './blocks.ts';
import { equip, itemCount, ownedSlots } from './inventory.ts';
import { clearLeafPath, leafBlock } from './leaf-clearing.ts';
import { has } from './traits.ts';

export const kinds = {
  knapping: { surface: 'knappingsurface', materials: s => has({ kind: 'item', code: s.code }, 'knappable') },
  clayforming: { surface: 'clayform', materials: s => has({ kind: 'item', code: s.code }, 'clayformable') },
};

const voxelPoint = (cell, [vx, vy, vz], top = true) => ({
  x: cell.x + (vx + 0.5) / 16,
  y: cell.y + (vy + (top ? 0.95 : 0.5)) / 16,
  z: cell.z + (vz + 0.5) / 16,
});

async function inspectSurface(field, cell, point?) {
  const state = await field.observe();
  const eye = { ...state.position, y: state.position.y + state.body.eyeHeight };
  await field.aim(lookAt(eye, point ?? { x: cell.x + 0.5, y: cell.y + 0.1, z: cell.z + 0.5 }));
  for (let i = 0; i < 3; i++) {
    const detail = await field.send({ action: 'inspect_target' });
    if (detail.key?.startsWith('block:')) {
      const hit = parseBlockKey(detail.key);
      if (hit.x === cell.x && hit.y === cell.y && hit.z === cell.z) return detail;
    }
    await field.wait(100);
  }
  return null;
}

// Find a solid ground cell with an exposed top face to place a forming surface on, aiming by cell id
// (the mod aims at the block's real selection box) rather than caller-computed angles. Forest floor is
// uneven, so several nearby cells are tried; grass above the cell is replaced by the surface on placement.
async function aimGround(field) {
  const state = await field.observe();
  const p = state.position;
  const tried = new Set();
  for (const offset of [0, 25, -25, 50, -50, 90, -90])
    for (const dist of [1.3, 1.0, 1.7]) {
      const radians = (normalize(state.orientation.yawDegrees + offset) * Math.PI) / 180;
      const x = Math.floor(p.x + Math.sin(radians) * dist),
        z = Math.floor(p.z + Math.cos(radians) * dist),
        y = Math.floor(p.y) - 1;
      const id = `${x},${y},${z}`;
      if (tried.has(id) || (Math.floor(p.x) === x && Math.floor(p.z) === z)) continue;
      tried.add(id);
      const aim = await field.send({ action: 'aim_cell', x, y, z, face: 'up' });
      if (!aim.ok) continue;
      await field.observe();
      const sel = await field.send({ action: 'inspect_target' });
      if (!sel.key?.startsWith('block:') || sel.face !== 'up' || replaceablePlant(sel.code)) continue;
      const hit = parseBlockKey(sel.key);
      if (hit.x !== x || hit.y !== y || hit.z !== z) continue; // occluded or grazed a neighbour
      // Free above for the surface, and clear sky for three blocks over it: leaves or branches over a
      // surface catch the aim at its voxels from where the body stands, and every click then takes minutes.
      if ([1, 2, 3].some(dy => field.env.map.get(hit.x, hit.y + dy, hit.z)?.boxes.length)) continue;
      return sel;
    }
  return null;
}

export async function form(field, { kind, output, material }) {
  const spec = kinds[kind];
  const surfaceCode = `game:${spec.surface}`;
  let inventory = await field.send({ action: 'inventory' });
  const initial = itemCount(inventory, output);
  const gained = async () => {
    inventory = await field.send({ action: 'inventory' });
    return itemCount(inventory, output) - initial;
  };
  material ??= ownedSlots(inventory)
    .filter(s => s.code && spec.materials(s))
    .sort((a, b) => Number(b.code === 'game:flint') - Number(a.code === 'game:flint'))[0]?.code;
  if (!material) throw Error('No owned base material for ' + kind);
  const summary = (extra = {}) => ({ kind, output, material, clicks, ...extra });
  let clicks = 0;
  await equip(field, { item: material });
  // Reuse an unfinished own surface in reach, else sneak-place one on the ground ahead.
  let cell = null;
  for (const object of await field.scan(6, spec.surface, 'blocks')) {
    if (object.code !== surfaceCode || !object.withinPickingRange) continue;
    const candidate = parseBlockKey(object.key);
    const detail = await inspectSurface(field, candidate);
    if (detail?.forming && detail.forming.material === material && (!detail.forming.recipe || detail.forming.recipe.output === output)) {
      cell = candidate;
      break;
    }
  }
  if (!cell) {
    const groundDetail = await aimGround(field);
    if (!groundDetail) throw Error('No selectable flat ground ahead for a surface; move to level ground');
    const ground = parseBlockKey(groundDetail.key);
    field.report('placing_surface', summary({ ground: groundDetail.key }));
    const placed = await useOnBlock(field, { target: groundDetail.key, item: material, sneak: true, holdMs: 300, consume: true, expectDialog: true });
    if (!placed.ok) return { ok: false, reason: 'surface_not_created', ...summary(), detail: placed };
    cell = { x: ground.x, y: ground.y + 1, z: ground.z };
  }
  const key = `block:0:${cell.x}:${cell.y}:${cell.z}:${surfaceCode}`;
  // The native recipe dialog blocks every control; a selection that fails must not leave it open.
  // Escape cancels it the way a player would (the game then removes the surface).
  const bail = async result => {
    await field.send({ action: 'close_dialog' }).catch(() => {});
    return result;
  };
  let detail;
  try {
    // Surface creation opens the native recipe dialog; select before inspecting so controls come back.
    const state = await field.send({ action: 'observe' });
    if (!state.controlReady || kind === 'clayforming') {
      await field.send({ action: 'select_recipe', target: key, output });
      await field.wait(300);
    }
    detail = await inspectSurface(field, cell);
    if (!detail?.forming) return bail({ ok: false, reason: 'surface_missing', ...summary() });
    if (!detail.forming.recipe) {
      if (!detail.forming.recipes?.some(r => r.output === output))
        return bail({ ok: false, reason: 'recipe_unavailable', ...summary(), recipes: detail.forming.recipes?.map(r => r.output) });
      await field.send({ action: 'select_recipe', target: key, output });
      detail = (await field.until((_, seen) => !!seen?.forming?.recipe, { timeoutMs: 3000, everyMs: 200, read: () => inspectSurface(field, cell) }))
        .read;
      if (detail?.forming?.recipe?.output !== output) return bail({ ok: false, reason: 'recipe_not_selected', ...summary() });
    }
  } catch (error) {
    await bail(null);
    throw error;
  }
  let stuck = 0,
    lastRemaining = detail.forming.remaining;
  const skipped = new Set();
  let lastLayerWaits = 0;
  while (true) {
    await field.observe(true);
    if (!detail?.forming) {
      // Surface gone: finished (output given) or destroyed.
      if ((await field.until(async () => (await gained()) >= 1, { timeoutMs: 2000, everyMs: 200 })).met)
        return { ok: true, goal: kind === 'knapping' ? 'knap' : 'clayform', ...summary(), gained: await gained(), verification: 'inventory_delta' };
      return { ok: false, reason: 'surface_gone_without_output', ...summary() };
    }
    const f = detail.forming;
    if (kind === 'clayforming' && f.layer >= 16 && f.remaining === 0) {
      // The finished form should hand over its output within a few seconds; it does not spin on it.
      if (++lastLayerWaits > 20) return { ok: false, reason: 'output_not_granted', ...summary() };
      await field.wait(300);
      detail = await inspectSurface(field, cell);
      continue;
    }
    field.report('forming', summary({ remaining: f.remaining, layer: f.layer, availableVoxels: f.availableVoxels }));
    const candidates = [...(f.extra ?? []).map(v => ({ v, click: 'attack' })), ...(f.missing ?? []).map(v => ({ v, click: 'interact' }))].filter(
      c => !skipped.has(c.v.join(',')),
    );
    if (!candidates.length) return { ok: false, reason: 'no_workable_voxels', ...summary(), remaining: f.remaining };
    const { v, click } = candidates[0];
    let aimed = null;
    for (let attempt = 0; attempt < 4 && !aimed; attempt++) {
      const point = voxelPoint(cell, v);
      const d = await inspectSurface(field, cell, point);
      if (
        d?.forming?.aimedVoxel &&
        d.forming.aimedVoxel[0] === v[0] &&
        d.forming.aimedVoxel[2] === v[2] &&
        (kind === 'knapping' || d.forming.aimedVoxel[1] === v[1])
      )
        aimed = d;
      else {
        // A leaf between the eye and the voxel is cut, once, the way a player clears the view of the surface.
        const blocking = await field.send({ action: 'inspect_target' }).catch(() => null);
        if (blocking?.code && leafBlock({ kind: 'block', code: blocking.code })) await clearLeafPath(field, point, 1);
        if (attempt === 3) skipped.add(v.join(','));
      }
    }
    if (!aimed) {
      detail = await inspectSurface(field, cell);
      continue;
    }
    inventory = await field.send({ action: 'inventory' });
    const held = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && s.slot === field.latest.activeSlot);
    if (held?.code !== material) {
      if (itemCount(inventory, material) < 1) return { ok: false, reason: 'out_of_material', ...summary() };
      await equip(field, { item: material });
    }
    await field.send({ action: click, durationMs: 120, expectedTarget: key });
    clicks++;
    await field.wait(350);
    detail = await inspectSurface(field, cell);
    if (detail?.forming) {
      if (detail.forming.remaining < lastRemaining) {
        stuck = 0;
        skipped.clear();
      } else if (++stuck >= 12) return { ok: false, reason: 'no_progress', ...summary(), remaining: detail.forming.remaining };
      lastRemaining = detail.forming.remaining;
    }
  }
}
