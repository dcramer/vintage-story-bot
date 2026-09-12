import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { horizontal, lookAt } from '../runtime/navigation/terrain.ts';
import { changeBlock, selectCell } from '../support/blocks.ts';
import { diggingSlot, known, solid } from '../support/digging.ts';
import { equip, ownedSlots } from '../support/inventory.ts';
import { runField } from '../support/task.ts';

// Night one without a house: dig two blocks into a bank at foot and head height, step in, and seal the
// mouth with a block from the pack. A one-by-two pocket in solid ground keeps drifters and wolves out.
const cardinals = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const earth = (map, x, y, z) => {
  const cell = map.get(x, y, z);
  return !!cell && solid(map, x, y, z) && !cell.traits.some(t => t === 'leaves' || t === 'plant' || t === 'shape' || t.startsWith('tier'));
};

// Recognize the one-cell shaft from observed blocks so a controller restart
// does not forget that the player is already sheltered underground.
export function dugInState(map, x, y, z): 'open' | 'sealed' | null {
  if (solid(map, x, y + 1, z)) return null;
  const upperRim = cardinals.filter(([ax, az]) => solid(map, x + ax, y + 2, z + az)).length;
  if (upperRim >= 3) return solid(map, x, y + 2, z) ? 'sealed' : 'open';
  // A hole begun on the surface can end with the body two blocks below the
  // neighbouring ground while the cell above that ground is open air. It is
  // still the emergency shaft digIn deliberately accepts when no seal is
  // available; recognize it after a controller restart instead of digging
  // another two blocks down. The same shallow rim may support the seal over
  // the shaft; that is the completed form, not unrelated solid ground.
  const lowerRim = cardinals.filter(([ax, az]) => solid(map, x + ax, y + 1, z + az)).length;
  if (lowerRim >= 3) return solid(map, x, y + 2, z) ? 'sealed' : 'open';
  return null;
}
// A blocking item the pack holds: dirt, sand, gravel, stone, logs, anything the game places as a block.
export const sealStone = inventory =>
  ownedSlots(inventory).find(s => s.itemClass === 'Block' && s.quantity > 0 && /soil-|sand-|gravel-|rock-|log-|cobble|clay-|peat/.test(s.code ?? ''));

// A place to burrow: a standable cell beside a bank of hand-diggable earth two blocks high and two deep,
// with earth around the pocket so it is sealed once the mouth is closed. Nearest first.
export function burrowSite(map, origin, radius = 10) {
  const sites: any[] = [];
  const ox = Math.floor(origin.x),
    oz = Math.floor(origin.z);
  for (let dx = -radius; dx <= radius; dx++)
    for (let dz = -radius; dz <= radius; dz++) {
      const node = map.nodeAt(ox + dx, oz + dz, origin.y, 3, 3);
      if (!node || node.wet || node.swim) continue;
      const x = Math.floor(node.x),
        z = Math.floor(node.z),
        h = Math.floor(node.y);
      for (const [ax, az] of cardinals) {
        const mouth = { x: x + ax, y: h, z: z + az },
          back = { x: x + 2 * ax, y: h, z: z + 2 * az };
        const cut = [mouth, { ...mouth, y: h + 1 }, back, { ...back, y: h + 1 }];
        if (!cut.every(c => earth(map, c.x, c.y, c.z))) continue;
        // Roof, floor and side walls of the pocket must be solid and known, or the pocket is not a pocket.
        const around = [
          { x: back.x + ax, y: h, z: back.z + az },
          { x: back.x + ax, y: h + 1, z: back.z + az },
          { x: mouth.x, y: h + 2, z: mouth.z },
          { x: back.x, y: h + 2, z: back.z },
          { x: mouth.x, y: h - 1, z: mouth.z },
          { x: back.x, y: h - 1, z: back.z },
          ...[
            [az, ax],
            [-az, -ax],
          ].flatMap(([px, pz]) => [
            { x: mouth.x + px, y: h, z: mouth.z + pz },
            { x: mouth.x + px, y: h + 1, z: mouth.z + pz },
            { x: back.x + px, y: h, z: back.z + pz },
            { x: back.x + px, y: h + 1, z: back.z + pz },
          ]),
        ];
        if (!around.every(c => known(map, c.x, c.y, c.z) && solid(map, c.x, c.y, c.z))) continue;
        sites.push({ stand: node, mouth, back, cut, distance: horizontal(node, origin) });
      }
    }
  return sites.sort((a, b) => a.distance - b.distance)[0] ?? null;
}

export async function burrow(field, survival) {
  const map = field.env.map;
  const state = await field.observe(true);
  const inventory = await field.send({ action: 'inventory' });
  const seal = sealStone(inventory);
  const site = seal ? burrowSite(map, state.position) : null;
  // With nothing to seal a bank pocket with, or no bank about, a hole where it stands: what it digs seals it.
  if (!site) return digIn(field, inventory);
  field.report('walking_to_bank', { stand: site.stand, mouth: site.mouth });
  if (horizontal(state.position, site.stand) > 0.6) {
    const walked = await field.walk({ ...site.stand, arrivalRadius: 0.4 }, survival?.pauseWhen);
    if (!['arrived', 'paused'].includes(walked.state)) return { ok: false, goal: 'burrow', reason: walked.reason ?? 'bank_unreachable' };
  }
  // Cut the mouth first, then the back, head height before foot height so nothing falls on the bot.
  for (const cell of site.cut
    .slice()
    .sort(
      (a, b) =>
        b.y - a.y || Math.abs(a.x - site.mouth.x) + Math.abs(a.z - site.mouth.z) - Math.abs(b.x - site.mouth.x) - Math.abs(b.z - site.mouth.z),
    )) {
    if (!solid(map, cell.x, cell.y, cell.z)) continue;
    if (horizontal(field.latest.position, cell) > 3 && cell.x === site.back.x && cell.z === site.back.z) {
      const inward = await field.walk({ x: site.mouth.x + 0.5, y: site.mouth.y, z: site.mouth.z + 0.5, arrivalRadius: 0.4 });
      if (!['arrived', 'paused'].includes(inward.state)) return { ok: false, goal: 'burrow', reason: 'mouth_unreachable' };
    }
    const selected = await selectCell(field, cell, { clearPlants: true });
    if (!selected) return { ok: false, goal: 'burrow', reason: 'cannot_aim', cell };
    const slot = await diggingSlot(field, selected, inventory);
    if (slot === null) return { ok: false, goal: 'burrow', reason: 'cannot_dig', cell, code: selected.code };
    field.report('cutting', { cell, code: selected.code });
    const dug = await changeBlock(field, 'dig', { target: selected.key, slot, acceptTransform: true, timeoutMs: 45000 });
    if (!dug.ok) return { ok: false, goal: 'burrow', reason: dug.reason ?? 'dig_failed', cell };
  }
  field.report('entering', { back: site.back });
  const inside = await field.walk({ x: site.back.x + 0.5, y: site.back.y, z: site.back.z + 0.5, arrivalRadius: 0.35 });
  if (!['arrived', 'paused'].includes(inside.state) || horizontal(field.latest.position, { x: site.back.x + 0.5, z: site.back.z + 0.5 }) > 0.6)
    return { ok: false, goal: 'burrow', reason: 'cannot_enter', back: site.back };
  // Seal: place the block on the top face of the floor under the mouth, from inside.
  const slot = (await equip(field, { item: seal.code })).slot;
  const floor = { x: site.mouth.x, y: site.mouth.y - 1, z: site.mouth.z };
  const point = { x: floor.x + 0.5, y: floor.y + 1, z: floor.z + 0.5 };
  await field.aim(lookAt({ ...field.latest.position, y: field.latest.position.y + field.latest.body.eyeHeight }, point));
  const support = await selectCell(field, floor, { point, face: 'up' });
  if (!support) return { ok: false, goal: 'burrow', reason: 'mouth_floor_not_selectable', inside: true };
  field.report('sealing', { mouth: site.mouth, item: seal.code });
  const placed = await changeBlock(field, 'place', { target: support.key, face: 'up', slot, expectedItem: seal.code });
  if (!placed.ok) return { ok: false, goal: 'burrow', reason: placed.reason ?? 'seal_failed', inside: true };
  return { ok: true, goal: 'burrow', mouth: site.mouth, inside: site.back, sealed: seal.code, verification: 'client_observed' };
}

// No bank about: a hole where it stands, two blocks straight down, the cell above the head closed
// with the seal stone placed against a rim block's inner face. Drifters do not climb into holes.
async function digIn(field, inventory) {
  const map = field.env.map;
  let start = field.latest.position;
  const x = Math.floor(start.x),
    z = Math.floor(start.z),
    center = { x: x + 0.5, y: start.y, z: z + 0.5 };
  // Near an edge, the body remains supported by the neighbouring blocks after
  // the floor is removed. Stand over the middle so each cut actually drops the
  // player into the shaft and keeps the next layer within native reach.
  if (horizontal(start, center) > 0.1) {
    field.report('centering_over_hole', { at: center });
    // Fine navigation deliberately treats any point in the current terrain
    // cell as arrived. Use short first-person walking pulses for this sub-cell
    // positioning, checking the observed body after each one.
    for (let pulse = 0; pulse < 4 && horizontal(field.latest.position, center) > 0.12; pulse++) {
      const distance = horizontal(field.latest.position, center);
      await field.aim({ yawDegrees: lookAt(field.latest.position, center).yawDegrees, pitchDegrees: 0 });
      const durationMs = Math.max(40, Math.min(120, Math.round(distance * 240)));
      await field.send({ action: 'move', direction: 'forward', durationMs, sprint: false, sneak: false });
      await field.wait(durationMs + 100);
      await field.observe(true);
    }
    if (horizontal(field.latest.position, center) > 0.2)
      return { ok: false, goal: 'burrow', reason: 'cannot_center', cell: { x, y: Math.floor(start.y), z } };
    start = field.latest.position;
  }
  let y = Math.floor(start.y);
  field.report('digging_in', { at: { x, y, z } });
  const priorShaft = dugInState(map, x, y, z);
  if (priorShaft === 'sealed') {
    const mouth = { x, y: y + 2, z };
    field.report('already_sheltered', { at: { x, y, z }, mouth });
    return {
      ok: true,
      goal: 'burrow',
      mouth,
      inside: { x, y, z },
      sealed: map.get(x, y + 2, z)?.code ?? 'observed block',
      dugIn: true,
      verification: 'client_observed',
    };
  }
  // A previous attempt may already have cut this shaft. Three solid rim cells
  // two blocks above mean the body is already down in a protective hole; keep
  // that useful work and proceed to sealing instead of mining into hard rock.
  const alreadyDugIn = priorShaft === 'open';
  if (alreadyDugIn) field.report('resuming_dug_in', { at: { x, y, z } });
  else {
    // Dig whatever the crosshair finds straight down, layer or plant or ground, until the feet are two
    // blocks lower than they started; the body drops into each cut.
    for (let cuts = 0; cuts < 6 && y > Math.floor(start.y) - 2; cuts++) {
      const eye = { ...field.latest.position, y: field.latest.position.y + field.latest.body.eyeHeight };
      await field.aim(lookAt(eye, { x: x + 0.5, y: field.latest.position.y - 0.5, z: z + 0.5 }));
      const selected = await field.send({ action: 'inspect_target' });
      if (!selected?.key?.startsWith('block:')) return { ok: false, goal: 'burrow', reason: 'cannot_aim', cell: { x, y: y - 1, z } };
      const slot = await diggingSlot(field, selected, inventory);
      if (slot === null) return { ok: false, goal: 'burrow', reason: 'cannot_dig', cell: { x, y: y - 1, z }, code: selected.code };
      field.report('cutting', { cell: selected.key, code: selected.code });
      const dug = await changeBlock(field, 'dig', { target: selected.key, slot, acceptTransform: true, timeoutMs: 45000 });
      if (!dug.ok) return { ok: false, goal: 'burrow', reason: dug.reason ?? 'dig_failed', cell: selected.key };
      await field.until(now => now.motion.onGround && now.position.y < y, { timeoutMs: 2000, everyMs: 250, sync: true });
      y = Math.floor(field.latest.position.y + 0.01);
    }
    if (y > Math.floor(start.y) - 2) return { ok: false, goal: 'burrow', reason: 'hole_too_shallow', depth: Math.floor(start.y) - y };
  }
  const mouth = { x, y: y + 2, z };
  // Two blocks down is out of a drifter's reach even open; the cell above is closed when a block is in hand.
  const seal = sealStone(await field.send({ action: 'inventory' }));
  if (!seal) return { ok: true, goal: 'burrow', mouth, inside: { x, y, z }, sealed: null, dugIn: true, verification: 'client_observed' };
  const slot = (await equip(field, { item: seal.code })).slot;
  const eye = { ...field.latest.position, y: field.latest.position.y + field.latest.body.eyeHeight };
  for (const [ax, az, face] of [
    [1, 0, 'west'],
    [-1, 0, 'east'],
    [0, 1, 'north'],
    [0, -1, 'south'],
  ] as [number, number, string][]) {
    const rim = { x: x + ax, y: y + 2, z: z + az };
    if (!solid(map, rim.x, rim.y, rim.z)) continue;
    const point = { x: rim.x + 0.5 - ax * 0.5, y: rim.y + 0.5, z: rim.z + 0.5 - az * 0.5 };
    await field.aim(lookAt(eye, point));
    const support = await selectCell(field, rim, { point, face });
    if (!support) continue;
    field.report('sealing', { mouth, item: seal.code });
    const placed = await changeBlock(field, 'place', { target: support.key, face, slot, expectedItem: seal.code });
    if (placed.ok) return { ok: true, goal: 'burrow', mouth, inside: { x, y, z }, sealed: seal.code, dugIn: true, verification: 'client_observed' };
  }
  // Unsealed, but dug in: still the best place to be at night.
  return { ok: true, goal: 'burrow', mouth, inside: { x, y, z }, sealed: null, dugIn: true, verification: 'client_observed' };
}

export default defineGoal({
  name: 'burrow',
  schema: z
    .object({
      timeoutMs: z.number().int().min(1000).max(1200000).default(300000),
    })
    .strict(),
  destructive: true,
  description:
    'Dig into the nearest bank of plain earth two blocks deep at foot and head height, step in, and seal the mouth ' +
    'with a block from the pack: a one-by-two pocket for the night. With no bank about, a hole where it stands: two ' +
    'blocks straight down, the cell above closed with the block. Ends with the mouth cell to dig out of in the ' +
    'morning (dig_area, then dig_out of the hole); the hole is dug even with nothing to seal it. Reasons: cannot_dig, cannot_enter, hole_too_shallow.',
  announce: () => 'Digging in for the night.',
  run: (env, options) => runField(env, options, ['inventory', 'block_actions'], (field, survival) => burrow(field, survival)),
});
