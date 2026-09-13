// Build by day near the chest when one is noted, on observed level ground.
// A verified entry and seal make the spot home.

import { shelterSite } from '../../../goals/shelter.ts';
import { shelter as blueprint, SHELTER_MATERIAL, shelterDoor } from '../../../support/structures.ts';
import type { Concern } from '../concern.ts';
import { goTo, setHome } from '../concern.ts';
import { lightingDay, prepareFirestarter } from './lighting.ts';
import { TORCH_MIN, torches } from './torches.ts';

// 57 rammed-earth blocks; six-block crafting batches plus four soil kept for emergencies.
export const SHELTER_DIRT = 64;

export const shelter: Concern = {
  id: 'shelter',
  title: 'a 5x5 rammed-earth shelter to call home',
  done: s => s.home && s.rammedShelter !== false,
  after: ['dirt', 'torches'],
  run: ctx => {
    const pending = ctx.memory.notes.shelter;
    if (pending) {
      const trip = goTo(ctx, { x: pending.x + 2.5, z: pending.z + 5.5 }, 'finishing the shelter', 5, 2);
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
    const trip = !pending && site && goTo(ctx, { x: site.x - 6, z: site.z }, 'the site by the chest', 3, 1);
    if (trip) return trip;
    const origin = pending ?? shelterSite(ctx.reading.terrain, ctx.state.position);
    if (!origin) return { start: 'explore', args: { legs: 1, timeoutMs: 180000 }, why: 'looking for supported shelter ground' };
    ctx.memory.notes.shelter = origin;
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
