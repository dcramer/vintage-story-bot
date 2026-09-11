import { horizontal, lookAt, normalize } from '../navigation/terrain.mjs';
import { equip, itemCount, ownedSlots } from './inventory.mjs';
import { parseBlockKey, selectCell, useOnBlock } from './use.mjs';

export const kinds = {
  knapping: { surface: 'knappingsurface', materials: s => s.code === 'game:flint' || /^game:stone-/.test(s.code) },
  clayforming: { surface: 'clayform', materials: s => /^game:clay-/.test(s.code) },
};

const voxelPoint = (cell, [vx, vy, vz], top = true) =>
  ({ x: cell.x + (vx + .5) / 16, y: cell.y + (vy + (top ? .95 : .5)) / 16, z: cell.z + (vz + .5) / 16 });

async function inspectSurface(field, cell, point) {
  const state = await field.observe();
  const eye = { ...state.position, y: state.position.y + state.body.eyeHeight };
  await field.aim(lookAt(eye, point ?? { x: cell.x + .5, y: cell.y + .1, z: cell.z + .5 }));
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

// Ground block one step ahead with a free cell above it, as observed terrain memory.
function groundAhead(field) {
  const p = field.latest.position, w = field.latest.body.halfWidth, h = field.latest.body.height;
  for (const offset of [0, 45, -45, 90, -90, 135, -135, 180]) {
    const radians = normalize(field.latest.orientation.yawDegrees + offset) * Math.PI / 180;
    const x = Math.floor(p.x + Math.sin(radians) * 1.5), z = Math.floor(p.z + Math.cos(radians) * 1.5), y = Math.floor(p.y) - 1;
    const ground = field.env.map.get(x, y, z), above = field.env.map.get(x, y + 1, z);
    if (ground && !ground.hazard && ground.boxes.some(b => Math.abs(b[4] - (y + 1)) < .01) && above && !above.hazard && !above.boxes.length &&
        !(Math.floor(p.x) === x && Math.floor(p.z) === z)) return { x, y, z };
  }
  return null;
}

export async function form(field, { kind, output, material }) {
  const spec = kinds[kind];
  const surfaceCode = `game:${spec.surface}`;
  let inventory = await field.send({ action: 'inventory' });
  const initial = itemCount(inventory, output);
  const gained = async () => { inventory = await field.send({ action: 'inventory' }); return itemCount(inventory, output) - initial; };
  material ??= ownedSlots(inventory).filter(s => s.code && spec.materials(s)).sort((a, b) => Number(b.code === 'game:flint') - Number(a.code === 'game:flint'))[0]?.code;
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
    if (detail?.forming && detail.forming.material === material && (!detail.forming.recipe || detail.forming.recipe.output === output)) { cell = candidate; break; }
  }
  if (!cell) {
    const ground = groundAhead(field);
    if (!ground) throw Error('No free flat ground block ahead for a surface; move to level ground');
    const groundDetail = await selectCell(field, ground, { point: { x: ground.x + .5, y: ground.y + .999, z: ground.z + .5 }, face: 'up', clearPlants: true });
    if (!groundDetail) throw Error('Ground block ahead not selectable');
    field.report('placing_surface', summary({ ground: groundDetail.key }));
    const placed = await useOnBlock(field, { target: groundDetail.key, item: material, sneak: true, holdMs: 300, consume: true, expectDialog: true });
    if (!placed.ok) return { ok: false, reason: 'surface_not_created', ...summary(), detail: placed };
    cell = { x: ground.x, y: ground.y + 1, z: ground.z };
  }
  const key = `block:0:${cell.x}:${cell.y}:${cell.z}:${surfaceCode}`;
  // Surface creation opens the native recipe dialog; select before inspecting so controls come back.
  const state = await field.send({ action: 'observe' });
  if (!state.controlReady || kind === 'clayforming') {
    await field.send({ action: 'select_recipe', target: key, output });
    await field.wait(300);
  }
  let detail = await inspectSurface(field, cell);
  if (!detail?.forming) return { ok: false, reason: 'surface_missing', ...summary() };
  if (!detail.forming.recipe) {
    if (!detail.forming.recipes?.some(r => r.output === output))
      return { ok: false, reason: 'recipe_unavailable', ...summary(), recipes: detail.forming.recipes?.map(r => r.output) };
    await field.send({ action: 'select_recipe', target: key, output });
    for (let i = 0; i < 15 && !detail?.forming?.recipe; i++) { await field.wait(200); detail = await inspectSurface(field, cell); }
    if (detail?.forming?.recipe?.output !== output) return { ok: false, reason: 'recipe_not_selected', ...summary() };
  }
  let stalled = 0, lastRemaining = detail.forming.remaining;
  const skipped = new Set();
  while (true) {
    await field.observe(true);
    if (!detail?.forming) {
      // Surface gone: finished (output given) or destroyed.
      for (let i = 0; i < 10; i++) { if (await gained() >= 1) return { ok: true, goal: kind === 'knapping' ? 'knap' : 'clayform', ...summary(), gained: await gained(), verification: 'inventory_delta' }; await field.wait(200); }
      return { ok: false, reason: 'surface_gone_without_output', ...summary() };
    }
    const f = detail.forming;
    if (kind === 'clayforming' && f.layer >= 16 && f.remaining === 0) { await field.wait(300); detail = await inspectSurface(field, cell); continue; }
    field.report('forming', summary({ remaining: f.remaining, layer: f.layer, availableVoxels: f.availableVoxels }));
    const candidates = [...(f.extra ?? []).map(v => ({ v, click: 'attack' })), ...(f.missing ?? []).map(v => ({ v, click: 'interact' }))]
      .filter(c => !skipped.has(c.v.join(',')));
    if (!candidates.length) return { ok: false, reason: 'no_workable_voxels', ...summary(), remaining: f.remaining };
    const { v, click } = candidates[0];
    let aimed = null;
    for (let attempt = 0; attempt < 4 && !aimed; attempt++) {
      const point = voxelPoint(cell, v);
      const d = await inspectSurface(field, cell, point);
      if (d?.forming?.aimedVoxel && d.forming.aimedVoxel[0] === v[0] && d.forming.aimedVoxel[2] === v[2] && (kind === 'knapping' || d.forming.aimedVoxel[1] === v[1])) aimed = d;
      else if (attempt === 3) skipped.add(v.join(','));
    }
    if (!aimed) { detail = await inspectSurface(field, cell); continue; }
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
      if (detail.forming.remaining < lastRemaining) { stalled = 0; skipped.clear(); } else if (++stalled >= 12) return { ok: false, reason: 'no_progress', ...summary(), remaining: detail.forming.remaining };
      lastRemaining = detail.forming.remaining;
    }
  }
}
