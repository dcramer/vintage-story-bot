import { randomUUID } from 'node:crypto';
import { distance, lookAt } from '../runtime/navigation/terrain.mjs';
import { ownedSlots } from './inventory.mjs';


const faces = { north: [0, 0, -1], east: [1, 0, 0], south: [0, 0, 1], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] };
const count = (inventory, code) => ownedSlots(inventory).filter(s => s.code === code).reduce((sum, s) => sum + s.quantity, 0);

export async function changeBlock(field, kind, { target, point, face, slot, expectedItem, acceptTransform = false, timeoutMs = 60000 }) {
  const [, dimension, x, y, z] = target.split(':');
  const cell = { x: Number(x), y: Number(y), z: Number(z) };
  if (Number(dimension) !== field.latest.position.dimension || Object.values(cell).some(n => !Number.isSafeInteger(n)))
    throw Error('Invalid target coordinates/dimension');
  const state = await field.observe();
  if (distance(state.position, cell) > 8) throw Error('Target out of local reach; move closer first');
  if (point && ['x', 'y', 'z'].some(axis => point[axis] < cell[axis] || point[axis] > cell[axis] + 1))
    throw Error('Aim point must lie in the target cell');
  const offset = faces[face] ?? [0, 0, 0];
  const aimPoint = point ?? Object.fromEntries(['x', 'y', 'z'].map((axis, i) => [axis, cell[axis] + .5 + offset[i] * .5]));
  await field.send({ action: 'select', slot: slot ?? state.activeSlot });
  field.report('aiming', { target, face });
  await field.aim(lookAt({ ...state.position, y: state.position.y + state.body.eyeHeight }, aimPoint));
  const selected = await field.send({ action: 'inspect_target' });
  if (selected.key !== target || face && selected.face !== face) throw Error('Target/face not in native reach or obstructed; no action sent');
  await field.observe();
  const inventory = await field.send({ action: 'inventory' });
  const held = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && s.slot === field.latest.activeSlot);
  if (!held || expectedItem !== undefined && held.code !== expectedItem) throw Error('Selected item changed');
  if (kind === 'place' && held.itemClass !== 'Block') throw Error('Placement requires a block stack');
  const id = randomUUID().replaceAll('-', '');
  field.report(kind === 'dig' ? 'digging' : 'placing', { target, operation: id });
  let operation = await field.send({ action: 'block_action_begin', id, kind, target, ...(face ? { face } : {}),
    slot: held.slot, item: held.code, expectedState: inventory.state, allowStarvingRecovery: field.recoveringFood });
  let sequence = 0;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    await field.observe();
    if (operation.state === 'cancelled' || operation.state === 'failed')
      return { ok: false, reason: operation.reason, operation };
    if (operation.state === 'changed') {
      field.report('verifying', { target, operation: id, position: operation.position, before: operation.before, after: operation.after });
      if (kind === 'dig' && operation.after !== 'game:air' && !acceptTransform)
        return { ok: false, reason: 'Block transformed, not removed; inspect before another attempt', operation };
      const contents = await field.send({ action: 'inventory' });
      const consumed = kind === 'place' ? count(inventory, held.code) - count(contents, held.code) : 0;
      const itemVerified = kind === 'dig' || field.latest.world.gameMode === 'Creative' || consumed === 1;
      // Client prediction may be corrected asynchronously. Observe a stable change, never claim server ACK.
      if (operation.changedForMs >= 1000 && itemVerified)
        return { ok: true, goal: `${kind}_block`, target, position: operation.position,
          before: operation.before, after: operation.after, ...(kind === 'place' ? { consumed } : {}),
          verification: 'client_observed', operation: id };
    }
    if (Date.now() >= deadline) {
      await field.env.send({ action: 'stop' });
      return { ok: false, reason: 'Block action timed out without an observed change', operation };
    }
    await field.wait(200);
    operation = await field.send({ action: kind === 'dig' && operation.state === 'working' ? 'block_action_continue' : 'block_action_status',
      id, sequence: ++sequence });
  }
}

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
