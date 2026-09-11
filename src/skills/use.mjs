import { distance, lookAt } from '../navigation/terrain.mjs';
import { equip, itemCount, ownedSlots } from './inventory.mjs';
import { changeBlock } from './blocks.mjs';

// Non-colliding vegetation the game replaces on placement but which still captures the selection ray.
export const replaceablePlant = code => /game:(tallgrass|tallfern|fern|flower|sapling|mushroom|shortgrass|plant-|reedpapyrus|drygrass)/.test(code ?? '');

export const parseBlockKey = key => {
  const [, dimension, x, y, z] = key.split(':');
  const cell = { x: Number(x), y: Number(y), z: Number(z), dimension: Number(dimension) };
  if (Object.values(cell).some(n => !Number.isSafeInteger(n))) throw Error('Invalid block key');
  return cell;
};

// Aim at a cell and return the native selection when it lands in that cell, else null.
// clearPlants digs replaceable vegetation that intercepts the ray (one block per call) and re-aims.
export async function selectCell(field, cell, { point, face, clearPlants = false } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await field.observe();
    const eye = { ...state.position, y: state.position.y + state.body.eyeHeight };
    const aimPoint = point ?? { x: cell.x + .5, y: cell.y + .5, z: cell.z + .5 };
    await field.aim(lookAt(eye, aimPoint));
    const selected = await field.send({ action: 'inspect_target' });
    if (!selected.key || !selected.key.startsWith('block:')) return null;
    const hit = parseBlockKey(selected.key);
    if (hit.x === cell.x && hit.y === cell.y && hit.z === cell.z) return !face || selected.face === face ? selected : null;
    if (!clearPlants || attempt > 0 || !replaceablePlant(selected.code)) return null;
    field.report('clearing_plant', { target: selected.key });
    const result = await changeBlock(field, 'dig', { target: selected.key, acceptTransform: true });
    if (!result.ok) return null;
  }
  return null;
}

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
