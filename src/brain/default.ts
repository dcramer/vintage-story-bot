// The default brain: a cautious beginner (docs/brain.md). It runs from
// monsters, hides at night and in storms, eats when hungry, and works through
// the day-1 kit and a tiny dirt shelter in order. No pottery, hunting or
// trading. Pure: decide() reads one Reading and its own memory and returns one
// Decision; the loop in src/runtime/brain.ts does the talking to the game.
import type { Brain, Decision, Reading } from '../runtime/brain.ts';
import { horizontal } from '../runtime/navigation/terrain.mjs';
import { temporalStormUnsafe } from '../support/fieldwork.mjs';
import { foodReserve, hunger } from '../support/food.mjs';
import { kinds } from '../support/forming.mjs';
import { ownedSlots } from '../support/inventory.mjs';
import { fleeTarget, nearestThreat } from '../support/threats.mjs';

export const STICK_MIN = 10;
export const TORCH_MIN = 2;
export const LOG_MIN = 8;
// 23 blocks for walls and roof, 2 to seal the door, a small margin.
export const SHELTER_DIRT = 28;
export const HUNGRY = 0.2;
export const KNIFE_BLADE = 'game:knifeblade-flint';
export const AXE_BLADE = 'game:axehead-flint';
export const KNIFE = 'game:knife-generic-flint';
export const AXE = 'game:axe-flint';
export const TORCH = 'game:torch-basic-extinct-up';
export const COOLDOWN_MS = 10 * 60 * 1000;
// Night when the sun is nearly gone; unknown light counts as day, since
// without a reading the brain cannot call itself home.
export const NIGHT_LIGHT = 0.25;

export type Job = 'hide' | 'go_home' | 'wait' | 'eat' | 'dirt' | 'shelter' | 'sticks' | 'stone' | 'tools' | 'grass' | 'torches' | 'logs' | 'explore';
type Cell = { x: number; y: number; z: number };
type Shelter = { origin: Cell; center: { x: number; z: number }; chunks: (Cell & { item: string })[][]; index: number;
  phase: 'walls' | 'enter' | 'seal' | 'torch' | 'done'; torch: string | null };
export type Memory = {
  home: Cell | null;
  cool: Map<Job, number>;
  shelter: Shelter | null;
  job: Job | null;
  done: Record<string, number>;
  scares: number;
  resting: boolean;
};

export const isNight = (environment: any) => typeof environment?.calendar?.daylight === 'number' && environment.calendar.daylight < NIGHT_LIGHT;

// What the bot carries, in plain counts.
export function kit(inventory: any) {
  const slots = ownedSlots(inventory) as any[];
  const exact = (code: string) => slots.filter(s => s.code === code).reduce((n, s) => n + s.quantity, 0);
  const part = (piece: string) => slots.filter(s => s.code?.includes(piece)).reduce((n, s) => n + s.quantity, 0);
  const tool = (name: string) => slots.some(s => s.tool === name && (s.durability ?? 1) > 0);
  return {
    sticks: exact('game:stick'), knife: tool('Knife'), axe: tool('Axe'),
    knifeBlade: exact(KNIFE_BLADE), axeBlade: exact(AXE_BLADE),
    torches: part('torch-basic'), torch: slots.find(s => s.code?.includes('torch-basic'))?.code ?? null,
    dirt: part('soil-'), dirtCode: slots.find(s => s.code?.includes('soil-'))?.code ?? null,
    stone: slots.some(s => s.code && kinds.knapping.materials(s)),
    grass: part('drygrass') + part('cattailtops'), logs: part('log-'),
    reserve: foodReserve(inventory) as number,
  };
}

// One-door box, 3 wide by 3 deep, walls 2 high, flat roof. origin is the
// floor-level corner: blocks sit on the ground top at origin.y; the door gap
// is 1 wide and 2 high in the middle of the +z wall.
export function shelterCells(origin: Cell, item: string) {
  const cells: (Cell & { item: string })[] = [];
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 3; dx++) for (let dz = 0; dz < 3; dz++) {
    if (dx !== 0 && dx !== 2 && dz !== 0 && dz !== 2) continue;
    if (dz === 2 && dx === 1) continue;
    cells.push({ x: origin.x + dx, y: origin.y + dy, z: origin.z + dz, item });
  }
  for (let dx = 0; dx < 3; dx++) for (let dz = 0; dz < 3; dz++) cells.push({ x: origin.x + dx, y: origin.y + 2, z: origin.z + dz, item });
  return cells;
}
export const doorCells = (origin: Cell, item: string) => [0, 1].map(dy => ({ x: origin.x + 1, y: origin.y + dy, z: origin.z + 2, item }));
const chunked = <T>(cells: T[], size = 8) => Array.from({ length: Math.ceil(cells.length / size) }, (_, i) => cells.slice(i * size, i * size + size));

export type Situation = {
  threat: boolean; storm: boolean; hunger: number | null; night: boolean; home: boolean; atHome: boolean;
  sticks: number; knife: boolean; axe: boolean; stone: boolean; torches: number; grass: number; dirt: number; logs: number;
};
// The whole character in one choice: danger, then hunger, then night, then
// the kit in day-1 order, then looking around.
export function pickJob(s: Situation): Job {
  if (s.threat) return 'hide';
  if (s.storm) return s.home && !s.atHome ? 'go_home' : 'wait';
  if (s.hunger !== null && s.hunger < HUNGRY) return 'eat';
  if (s.night) return s.home ? (s.atHome ? 'wait' : 'go_home') : s.dirt >= SHELTER_DIRT ? 'shelter' : 'wait';
  if (!s.home) return s.dirt >= SHELTER_DIRT ? 'shelter' : 'dirt';
  if (s.sticks < STICK_MIN) return 'sticks';
  if (!s.knife || !s.axe) return s.stone ? 'tools' : 'stone';
  if (s.torches < TORCH_MIN) return s.grass > 0 ? 'torches' : 'grass';
  if (s.logs < LOG_MIN) return 'logs';
  return 'explore';
}

function shelterStep(memory: Memory, position: Cell, dirt: string, torch: string | null): { start: string; args: Record<string, unknown> } {
  if (!memory.shelter) {
    const origin = { x: Math.floor(position.x) + 2, y: Math.floor(position.y), z: Math.floor(position.z) - 1 };
    memory.shelter = { origin, center: { x: origin.x + 1.5, z: origin.z + 1.5 }, chunks: chunked(shelterCells(origin, dirt)), index: 0, phase: 'walls', torch };
  }
  const shelter = memory.shelter;
  shelter.torch ??= torch;
  if (shelter.phase === 'walls') return { start: 'build', args: { cells: shelter.chunks[shelter.index], timeoutMs: 900000 } };
  if (shelter.phase === 'enter') return { start: 'travel', args: { x: shelter.center.x, z: shelter.center.z, arrivalRadius: 0.5, timeoutMs: 600000 } };
  if (shelter.phase === 'seal') return { start: 'build', args: { cells: doorCells(shelter.origin, dirt), timeoutMs: 300000 } };
  return { start: 'build', args: { cells: [{ x: shelter.origin.x + 1, y: shelter.origin.y, z: shelter.origin.z + 1, item: shelter.torch }], timeoutMs: 300000 } };
}
// Move the shelter one phase forward after its goal finished well; a failed
// phase abandons this attempt and cools the job.
function shelterAdvance(memory: Memory, ok: boolean, now: number) {
  const shelter = memory.shelter;
  if (!shelter) return;
  if (!ok) { memory.cool.set('shelter', now + COOLDOWN_MS); memory.shelter = null; return; }
  if (shelter.phase === 'walls' && ++shelter.index >= shelter.chunks.length) shelter.phase = 'enter';
  else if (shelter.phase === 'enter') shelter.phase = 'seal';
  else if (shelter.phase === 'seal') shelter.phase = shelter.torch ? 'torch' : 'done';
  else if (shelter.phase === 'torch') shelter.phase = 'done';
  if (shelter.phase === 'done') { memory.home = { x: shelter.center.x, y: shelter.origin.y, z: shelter.center.z }; memory.shelter = null; }
}

export function decide(reading: Reading, memory: Memory): Decision {
  const { state, inventory, environment, active, last, now } = reading;
  // Bookkeeping for the brain's own goal that just ended.
  if (last) {
    if (last.ok) memory.done[last.kind] = (memory.done[last.kind] ?? 0) + 1;
    if (memory.job === 'shelter') shelterAdvance(memory, last.ok, now);
    // Running away is tried again at once; every other failed job rests a while.
    else if (!last.ok && memory.job && memory.job !== 'hide') memory.cool.set(memory.job, now + COOLDOWN_MS);
    memory.job = null;
  }
  if (memory.resting) return { wait: 'resting after too many scares' };
  const threat = nearestThreat(state);
  let satiety: number | null = null;
  try { satiety = hunger(state); } catch { satiety = null; }
  const storm = temporalStormUnsafe(state);
  // A goal of its own is running: only danger, storms and hunger cut it short.
  if (active) {
    if (threat && memory.job !== 'hide') return { stop: 'threat' };
    if (storm && !['go_home', 'wait'].includes(memory.job ?? '')) return { stop: 'storm' };
    if (satiety !== null && satiety < HUNGRY && memory.job !== 'eat') return { stop: 'hungry' };
    return { wait: `letting ${active.kind} finish` };
  }
  const k = kit(inventory);
  const home = memory.home;
  const job = pickJob({
    threat: !!threat, storm, hunger: satiety, night: isNight(environment),
    home: !!home, atHome: !!home && horizontal(state.position, home) < 8,
    sticks: k.sticks, knife: k.knife, axe: k.axe, stone: k.stone, torches: k.torches, grass: k.grass, dirt: k.dirt, logs: k.logs,
  });
  if ((memory.cool.get(job) ?? 0) > now) return { wait: `${job} cooling down` };
  const start = (goal: string, args: Record<string, unknown>, why: string): Decision => { memory.job = job; return { start: goal, args, why }; };
  switch (job) {
    case 'wait': return { wait: storm ? 'storm' : 'night, nowhere to go' };
    case 'hide': {
      const away = fleeTarget(state.position, threat);
      return start('travel', { x: away.x, z: away.z, arrivalRadius: 3, timeoutMs: 600000 }, `${threat.code} at ${Math.round(horizontal(state.position, threat.point))} blocks`);
    }
    case 'go_home': return start('travel', { x: home!.x, z: home!.z, arrivalRadius: 3, timeoutMs: 600000 }, storm ? 'storm coming' : 'night falling');
    case 'eat': return k.reserve > 0
      ? start('eat', {}, `satiety ${Math.round((satiety ?? 0) * 100)}%`)
      : start('forage', { timeoutMs: 1800000 }, `satiety ${Math.round((satiety ?? 0) * 100)}%, nothing carried`);
    case 'dirt': return start('harvest', { match: 'soil-', item: 'soil-', count: Math.max(1, SHELTER_DIRT - k.dirt), timeoutMs: 900000 }, `${k.dirt}/${SHELTER_DIRT} dirt for a shelter`);
    case 'shelter': {
      const step = shelterStep(memory, state.position, k.dirtCode ?? 'game:soil-medium-none', k.torch);
      return start(step.start, step.args, `shelter ${memory.shelter?.phase}`);
    }
    case 'sticks': return start('gather_sticks', { count: STICK_MIN - k.sticks, timeoutMs: 600000 }, `${k.sticks}/${STICK_MIN} sticks`);
    case 'stone': return start('harvest', { match: 'loosestone', item: 'stone-', count: 2, timeoutMs: 600000 }, 'no stone to knap');
    case 'tools':
      if (!k.knife) return k.knifeBlade < 1
        ? start('knap', { output: KNIFE_BLADE, timeoutMs: 600000 }, 'no knife')
        : start('craft_item', { output: KNIFE, count: 1, timeoutMs: 300000 }, 'haft the knife blade');
      return k.axeBlade < 1
        ? start('knap', { output: AXE_BLADE, timeoutMs: 600000 }, 'no axe')
        : start('craft_item', { output: AXE, count: 1, timeoutMs: 300000 }, 'haft the axe head');
    case 'grass': return start('harvest', { match: 'tallgrass', item: 'drygrass', count: 4, timeoutMs: 600000 }, 'grass for torches');
    case 'torches': return start('craft_item', { output: TORCH, count: Math.max(1, TORCH_MIN - k.torches), timeoutMs: 300000 }, `${k.torches}/${TORCH_MIN} torches`);
    case 'logs': return start('fell_tree', { count: Math.max(1, LOG_MIN - k.logs), timeoutMs: 1200000 }, `${k.logs}/${LOG_MIN} logs`);
    case 'explore': return start('explore', { legs: 2, timeoutMs: 600000 }, 'kit done, looking around');
  }
}

// What to pick up in passing, whatever the current job: the kit's shortfalls that lie on the ground.
export function wants(reading: Reading): string[] {
  const k = kit(reading.inventory);
  const list: string[] = [];
  if (k.sticks < STICK_MIN) list.push('stick');
  if ((!k.knife || !k.axe) && !k.stone) list.push('flint', 'loosestones');
  return list;
}

export function fresh(): Memory {
  return { home: null, cool: new Map(), shelter: null, job: null, done: {}, scares: 0, resting: false };
}

const brain: Brain<Memory> = {
  name: 'default',
  description:
    'A cautious beginner: runs from monsters, hides at night and in storms, eats when hungry, gathers sticks and stone, ' +
    'knaps a knife and axe, crafts torches, chops logs, builds a small dirt shelter, and looks around when there is nothing else to do.',
  fresh,
  decide,
  wants,
  summary: memory => ({ home: memory.home, job: memory.job, shelter: memory.shelter?.phase ?? null, done: memory.done,
    cooling: [...memory.cool].filter(([, until]) => until > Date.now()).map(([job]) => job) }),
};
export default brain;
