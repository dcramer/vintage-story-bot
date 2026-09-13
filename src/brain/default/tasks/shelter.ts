// Build by day near the chest when one is noted, on observed level ground.
// A verified entry and seal make the spot home.

import { shelterSite } from '../../../goals/shelter.ts';
import { shelterCover } from '../../../support/sites.ts';
import { shelter as blueprint, SHELTER_MATERIAL, shelterDoor, shelterStorage, shelterTorches } from '../../../support/structures.ts';
import type { Concern } from '../concern.ts';
import { goTo, setHome } from '../concern.ts';
import { lightingDay, prepareFirestarter } from './lighting.ts';
import { TORCH_MIN, torches } from './torches.ts';

// 57 rammed-earth blocks; six-block crafting batches plus four soil kept for emergencies.
export const SHELTER_DIRT = 64;

function obstructedShelter(map, origin) {
  const shell = new Set(
    [...blueprint(origin, SHELTER_MATERIAL), ...shelterDoor(origin, SHELTER_MATERIAL)].map(cell => `${cell.x}:${cell.y}:${cell.z}`),
  );
  const storage = new Set(shelterStorage(origin).map(cell => `${cell.x}:${cell.y}:${cell.z}`));
  const torches = new Set(shelterTorches(origin).map(cell => `${cell.x}:${cell.y}:${cell.z}`));
  for (let x = origin.x; x < origin.x + 5; x++)
    for (let z = origin.z; z < origin.z + 5; z++)
      for (let y = origin.y; y <= origin.y + 2; y++) {
        const block = map?.get(x, y, z);
        if (!block || block.code === 'game:air' || block.code == null) continue;
        if (shelterCover(block, y - origin.y)) continue;
        const key = `${x}:${y}:${z}`;
        if (storage.has(key) && /^game:(stationarybasket|chest)-/.test(block.code)) continue;
        if (torches.has(key) && block.code.startsWith('game:torch-basic-')) continue;

        if (shell.has(`${x}:${y}:${z}`) && block.code.includes(SHELTER_MATERIAL)) continue;
        return true;
      }
  return false;
}

export const shelter: Concern = {
  id: 'shelter',
  title: 'a 5x5 rammed-earth shelter to call home',
  done: s => s.home && s.rammedShelter !== false,
  after: ['dirt', 'torches'],
  run: ctx => {
    let pending = ctx.memory.notes.shelter;
    // A foreign block can occupy the shell or aisle between a
    // partial build and its resume. Explicitly observed foreign blocks make
    // this site unusable; forget it and survey a fresh footprint instead of
    // repeatedly trying to clear or build through the obstruction.
    if (pending && obstructedShelter(ctx.reading.terrain, pending)) {
      ctx.memory.notes.shelter = null;
      pending = null;
    }
    if (pending) {
      const trip = goTo(ctx, { x: pending.x + 2.5, y: pending.y, z: pending.z + 5.5 }, 'finishing the shelter', 5, 2);
      if (trip) return trip;
    }
    const count = code => ctx.k.slots.filter(s => s.code === code).reduce((n, s) => n + s.quantity, 0);
    const rammed = count(SHELTER_MATERIAL);
    const required = pending
      ? [...blueprint(pending, SHELTER_MATERIAL), ...shelterDoor(pending, SHELTER_MATERIAL)].filter(
          c => ctx.reading.terrain?.get(c.x, c.y, c.z)?.code !== SHELTER_MATERIAL,
        ).length
      : 57;
    const batch = Math.ceil(required / 6) * 6;
    if (rammed < required) {
      const packed = count('game:packeddirt');
      if (packed >= 6)
        return {
          start: 'craft_item',
          args: { output: SHELTER_MATERIAL, count: Math.min(batch - rammed, Math.floor(packed / 6) * 6), timeoutMs: 300000 },
          why: 'rammed earth for the shelter template',
        };
      if (ctx.k.dirt >= 10)
        return {
          start: 'craft_item',
          args: { output: 'game:packeddirt', count: Math.min(batch - rammed, Math.floor((ctx.k.dirt - 4) / 6) * 6), timeoutMs: 300000 },
          why: 'packed dirt for the rammed-earth shelter',
        };
      return {
        start: 'harvest',
        args: {
          match: 'soil-low-',
          item: 'soil-low-none',
          count: Math.max(1, batch + 4 - rammed - packed - ctx.k.dirt),
          tool: 'Shovel',
          timeoutMs: 600000,
        },
        why: 'soil for the shelter and a door reserve',
      };
    }
    if (ctx.k.torches < TORCH_MIN) return torches.run(ctx);
    const prepare = prepareFirestarter(ctx);
    if (prepare) return prepare;
    const site = ctx.memory.notes.stash;
    const trip = !pending && site && goTo(ctx, { x: site.x - 6, y: site.y, z: site.z }, 'the site by the chest', 3, 1);
    if (trip) return trip;
    const origin = pending ?? shelterSite(ctx.reading.terrain, ctx.state.position);
    if (!origin) return { start: 'explore', args: { legs: 1, timeoutMs: 180000 }, why: 'looking for supported shelter ground' };
    ctx.memory.notes.shelter = origin;
    const approach = goTo(ctx, { x: origin.x + 2.5, y: origin.y, z: origin.z + 5.5 }, 'returning to observed shelter ground', 5, 2);
    if (approach) return approach;
    return { start: 'shelter', args: { origin, item: SHELTER_MATERIAL, timeoutMs: 1800000 }, why: `${rammed} rammed earth, finishing the shelter` };
  },
  // A finished shelter is home.
  ended: (last, memory, reading) => {
    if (last.ok && last.result?.home) {
      memory.notes.shelter = null;
      setHome(memory, last.result.home);
      if (last.result.lit) memory.notes.lightingDay = lightingDay(reading.environment);
      const origin = last.result.origin;
      if (origin) {
        memory.notes.starter = origin;
        const { item: _, ...door } = shelterDoor(origin, SHELTER_MATERIAL)[0];
        memory.notes.dwelling = { door, item: last.result.item ?? SHELTER_MATERIAL };
      }
    }
  },
};
