// One tick's reading, summed up: what the ladder and the tasks decide on.
// Reads state, inventory, events and notes; writes the food-recovery flag,
// the set-aside list and the cached summary back to memory. Called once per
// decision, before anything is picked or started.
import type { Reading } from '../../runtime/brain.ts';
import { horizontal } from '../../runtime/navigation/terrain.ts';
import { temporalStormUnsafe } from '../../support/fieldwork.ts';
import { hunger } from '../../support/food.ts';
import { allStashes, type Concern, insideHome, type Job, type Memory, TRIED_MS, TRIED_RADIUS } from './concern.ts';
import type { BrainState, BrainTerrain } from './reading.ts';
import { dangerHere } from './reflexes/relocate.ts';
import { SIEGE_MS } from './reflexes/tunnel.ts';
import { isNight, type Kit, kit, type Situation, senseDanger } from './situation.ts';
import { farmDue } from './tasks/farm.ts';
import { shelterLight } from './tasks/lighting.ts';
import { recoverableBody } from './tasks/recover.ts';
import { homeDamage } from './tasks/repair_home.ts';
import { resupplyOf } from './tasks/resupply.ts';
import { FULL_SLOTS, surplusOf } from './tasks/stash.ts';
import { STOCK_CHECK_MS, suppliesMissing } from './tasks/stockpile.ts';

// A hostile this close to the mouth makes opening it death.
export const THREAT_NEAR = 6;

// The jobs set aside around here: failed within a few minutes and, unless the job says
// everywhere, within a few blocks of where it failed.
function triedNow(memory: Memory, position: { x: number; z: number }, now: number, lookup: (job: Job) => Concern | undefined) {
  return new Set<Job>(
    (Object.entries(memory.tried) as [Job, { x: number; z: number; at: number }][])
      .filter(([job, where]) => now - where.at < TRIED_MS && (lookup(job)?.setAsideEverywhere || horizontal(position, where) <= TRIED_RADIUS))
      .map(([job]) => job),
  );
}

export type Digest = {
  s: Situation;
  k: Kit;
  tried: Set<Job>;
  danger: { point: { x: number; y: number; z: number }; code: string } | null;
  hurt: boolean;
  classifyingHurt: boolean;
  satiety: number | null;
  storm: boolean;
  home: { x: number; y: number; z: number } | null;
  dwelling: { door: { x: number; y: number; z: number }; item: string } | null | undefined;
  inside: boolean;
  sealed: boolean;
};

export function digestReading(reading: Reading, memory: Memory, lookup: (job: Job) => Concern | undefined): Digest {
  const { inventory, environment, markers = [], now } = reading;
  const state = reading.state as BrainState;
  const terrain = reading.terrain as BrainTerrain | undefined;
  const { danger, hurt, classifyingHurt } = senseDanger(reading, memory, now < memory.explainedUntil);
  let satiety: number | null = null;
  try {
    satiety = hunger(state);
  } catch {
    satiety = null;
  }
  const storm = temporalStormUnsafe(state);
  const k = kit(inventory);
  // Hunger may consume food already in the pack, but an empty pack does not
  // turn construction into an open-ended scavenging trip. Useful work and
  // recoverable materials survive a death; the default brain can respawn and
  // continue, then prepare optional provisions once the camp is established.
  if (satiety !== null && satiety < 0.2 && k.reserve > 0) memory.notes.foodRecovery = true;
  else if (k.reserve <= 0 || (satiety !== null && satiety >= 0.5)) {
    delete memory.notes.foodRecovery;
  }
  // A winter shelter on lake ice is not a durable home. Once that seasonal
  // floor is positively observed, forget the shelter coordinates so storage,
  // lighting and weather reflexes cannot keep routing work back onto the lake.
  const rememberedHome = memory.notes.home;
  const rememberedFloor = rememberedHome
    ? terrain?.get(Math.floor(rememberedHome.x), Math.floor(rememberedHome.y) - 1, Math.floor(rememberedHome.z))
    : null;
  if (rememberedFloor && /(?:^|:)lakeice$/.test(rememberedFloor.code ?? '')) {
    memory.notes.home = null;
    memory.notes.starter = null;
    memory.notes.dwelling = null;
  }
  const home = memory.notes.home;
  const tried = triedNow(memory, state.position, now, lookup);
  const dwelling = memory.notes.dwelling;
  const houseOrigin = memory.notes.house;
  const starter = memory.notes.starter;
  const rammedShelter = !!starter || !!houseOrigin || !!memory.notes.construction;
  const light = shelterLight(reading, memory.notes);
  const inside = insideHome(memory.notes, state.position);
  const sealed =
    !!dwelling &&
    [0, 1].every(dy => {
      const block = terrain?.get(dwelling.door.x, dwelling.door.y + dy, dwelling.door.z);
      return !!block && !block.hazard && block.boxes.length > 0;
    });
  const damaged = inside && homeDamage(reading, memory.notes).length > 0;
  const stashes = allStashes(memory.notes);
  const missing = suppliesMissing(stashes);
  const s: Situation = {
    threat: !!danger,
    threatNear: !!danger && horizontal(state.position, danger.point) <= THREAT_NEAR,
    hurt,
    storm,
    hunger: satiety,
    foodRecovery: memory.notes.foodRecovery,
    reserve: k.reserve,
    night:
      isNight(environment) ||
      (!!home &&
        typeof environment?.calendar?.hourOfDay === 'number' &&
        environment.calendar.hourOfDay >= 17 - Math.min(3, horizontal(state.position, home) / 120)),
    home: !!home,
    atHome: dwelling ? inside && sealed : !!home && horizontal(state.position, home) < 0.7 && Math.abs(state.position.y - home.y) < 1,
    sheltered: !!dwelling && inside && sealed && !damaged,
    homeDamaged: damaged,
    burrowed: !!memory.burrow && horizontal(state.position, memory.burrow) <= 8,
    besieged: !isNight(environment) && memory.besiegedAt !== null && now - memory.besiegedAt >= SIEGE_MS,
    dangerHere: dangerHere(memory, state.position),
    body: recoverableBody(markers, memory.notes, now),
    sticks: k.sticks,
    knife: k.knife,
    axe: k.axe,
    shovel: k.shovel,
    hoe: k.hoe,
    farmTended: !farmDue(reading, memory.notes.farm),
    stone: k.stone,
    torches: k.torches + light.installed,
    grass: k.grass,
    dirt: k.dirt,
    buildingMaterials: k.buildingMaterials,
    rammedShelter,
    shelterReady:
      !starter &&
      !houseOrigin &&
      !memory.notes.construction &&
      ((!!memory.notes.shelter && k.rammed > 0) || (k.rammed >= 60 && k.torches > 0 && k.slots.some(s => s.code === 'game:firestarter'))),

    logs: k.logs,
    storage: !!memory.notes.stash,
    bags: k.bags,
    full: k.free <= FULL_SLOTS,
    surplus: surplusOf(k, {
      home: !!home,
      torches: k.torches,
      building: !!memory.notes.construction || !!memory.notes.shelter,
      farming: !!memory.notes.farm,
    }).reduce((n, i) => n + i.count, 0),
    short: resupplyOf(k, { home: !!home, torches: k.torches, rammedShelter }, memory.notes.stash).reduce((n, i) => n + i.count, 0),
    moreStorage: stashes.length < 3 && stashes.length > 0 && stashes.every(stash => stash.full) && missing.length > 0,
    house: !!memory.notes.house,
    lit: light.lit,
    stocked: stashes.length > 0 && stashes.every(stash => stash.seen && now - stash.seen.at < STOCK_CHECK_MS) && missing.length === 0,
    stashKnife: Object.keys(memory.notes.stash?.seen?.items ?? {}).some(code => code.includes('knife-')),
  };
  memory.situation = s;
  memory.tried_now = [...tried];
  return { s, k, tried, danger, hurt, classifyingHurt, satiety, storm, home, dwelling, inside, sealed };
}
