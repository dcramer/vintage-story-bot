// The default brain: a cautious beginner (docs/brain.md). It runs from
// monsters, hides at night and in storms, eats when hungry, and works through
// the day-1 kit and a tiny dirt shelter in order. No pottery, hunting or
// trading. Pure: decide() reads one Reading and its own memory and returns one
// Decision; the loop in src/runtime/brain.ts does the talking to the game.
import type { Brain, Decision, Reading } from '../runtime/brain.ts';
import { horizontal } from '../runtime/navigation/terrain.ts';
import { temporalStormUnsafe } from '../support/fieldwork.ts';
import { foodReserve, hunger } from '../support/food.ts';
import { kinds } from '../support/forming.ts';
import { ownedSlots } from '../support/inventory.ts';
import { fleeTarget, nearestThreat } from '../support/threats.ts';

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
export const SHOVEL_BLADE = 'game:shovelhead-flint';
export const SHOVEL = 'game:shovel-flint';
export const TORCH = 'game:torch-basic-extinct-up';
export const COOLDOWN_MS = 10 * 60 * 1000;
// Night when the sun is nearly gone; unknown light counts as day, since
// without a reading the brain cannot call itself home.
export const NIGHT_LIGHT = 0.25;
// Three scares within this many blocks in this long make a place worth leaving, by this far.
export const DANGER_SCARES = 3;
export const DANGER_RADIUS = 48;
export const DANGER_MS = 15 * 60 * 1000;
export const RELOCATE_DISTANCE = 96;

export type Job =
  | 'hide'
  | 'go_home'
  | 'wait'
  | 'eat'
  | 'dirt'
  | 'shelter'
  | 'sticks'
  | 'stone'
  | 'tools'
  | 'grass'
  | 'torches'
  | 'logs'
  | 'explore'
  | 'dig_out'
  | 'burrow'
  | 'unburrow'
  | 'seal'
  | 'relocate';
type Cell = { x: number; y: number; z: number };
export type Memory = {
  home: Cell | null;
  cool: Map<Job, number>;
  job: Job | null;
  // Where the last walk was heading when it ended in a pit; dig_out cuts stairs that way.
  pit: { x: number; z: number } | null;
  // The pocket the bot dug in for the night: its mouth cell, to dig open again at dawn.
  burrow: { x: number; y: number; z: number } | null;
  done: Record<string, number>;
  // Where and when the bot had to run; a cluster of these around it means this is a bad place to be.
  scares: { x: number; z: number; at: number }[];
  // Loose sticks ran out here: break leaves for them next time.
  sticksFromLeaves: boolean;
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
    sticks: exact('game:stick'),
    knife: tool('Knife'),
    axe: tool('Axe'),
    shovel: tool('Shovel'),
    shovelBlade: exact(SHOVEL_BLADE),
    knifeBlade: exact(KNIFE_BLADE),
    axeBlade: exact(AXE_BLADE),
    torches: part('torch-basic'),
    torch: slots.find(s => s.code?.includes('torch-basic'))?.code ?? null,
    dirt: part('soil-'),
    dirtCode: slots.find(s => s.code?.includes('soil-'))?.code ?? null,
    stone: slots.some(s => s.code && kinds.knapping.materials(s)),
    grass: part('drygrass') + part('cattailtops'),
    logs: part('log-'),
    reserve: foodReserve(inventory) as number,
  };
}

export type Situation = {
  threat: boolean;
  storm: boolean;
  hunger: number | null;
  night: boolean;
  home: boolean;
  atHome: boolean;
  burrowed: boolean;
  dangerHere: boolean;
  sticks: number;
  knife: boolean;
  axe: boolean;
  shovel: boolean;
  stone: boolean;
  torches: number;
  grass: number;
  dirt: number;
  logs: number;
};
// The whole character in one choice: danger, then hunger, then night, then the
// day-1 kit in the order its dependencies impose. A shelter needs dirt, dirt
// needs a shovel, a shovel (like a knife and an axe) needs a knapped head and
// a stick, a head needs flint or stone. Night without a home means a burrow,
// which needs one block in hand: that block alone may be dug bare-handed.
export function pickJob(s: Situation): Job {
  if (s.threat) return 'hide';
  if (s.storm) return s.home && !s.atHome ? 'go_home' : 'wait';
  if (s.hunger !== null && s.hunger < HUNGRY) return 'eat';
  // A place that keeps producing scares is left behind, day or night, before anything else here.
  if (s.dangerHere && !s.burrowed) return 'relocate';
  if (s.night) return s.home ? (s.atHome ? 'wait' : 'go_home') : s.burrowed ? 'wait' : s.dirt > 0 ? 'burrow' : 'seal';
  if (s.burrowed) return 'unburrow';
  if (s.sticks < STICK_MIN) return 'sticks';
  if (!s.knife || !s.axe || !s.shovel) return s.stone ? 'tools' : 'stone';
  if (!s.home) return s.dirt >= SHELTER_DIRT ? 'shelter' : 'dirt';
  if (s.torches < TORCH_MIN) return s.grass > 0 ? 'torches' : 'grass';
  if (s.logs < LOG_MIN) return 'logs';
  return 'explore';
}

export function decide(reading: Reading, memory: Memory): Decision {
  const { state, inventory, environment, active, last, now } = reading;
  // Bookkeeping for the brain's own goal that just ended.
  if (last) {
    if (last.ok) memory.done[last.kind] = (memory.done[last.kind] ?? 0) + 1;
    // A walk that ended in a hole is not a failed job: the hole is dealt with first.
    if (last.reason === 'pit' && last.result?.position) memory.pit = { x: last.result.position.x + 8, z: last.result.position.z };
    // Running away is tried again at once, and a job the surroundings refused before it began (water, lost
    // controls) is not the job's fault; every other failed job rests a while.
    else if (!last.ok && memory.job && !['hide', 'dig_out'].includes(memory.job) && !/interruption/.test(last.reason ?? ''))
      memory.cool.set(memory.job, now + COOLDOWN_MS);
    if (memory.job === 'dig_out') memory.pit = null;
    // A finished shelter is home.
    if (memory.job === 'shelter' && last.ok && last.result?.home) memory.home = last.result.home;
    if (memory.job === 'burrow' && last.ok && last.result?.mouth) memory.burrow = last.result.mouth;
    if (memory.job === 'unburrow' && last.ok) memory.burrow = null;
    // Whatever the trip's outcome, this place has been judged; judge the new one afresh.
    if (memory.job === 'relocate') memory.scares = [];
    if (memory.job === 'sticks') memory.sticksFromLeaves = !last.ok && last.reason !== 'pit';
    memory.job = null;
  }
  if (memory.resting) return { wait: 'resting after too many scares' };
  memory.scares = memory.scares.filter(scare => now - scare.at < DANGER_MS);
  const threat = nearestThreat(state);
  let satiety: number | null = null;
  try {
    satiety = hunger(state);
  } catch {
    satiety = null;
  }
  const storm = temporalStormUnsafe(state);
  // A goal of its own is running: only danger, storms and hunger cut it short.
  if (active) {
    // A flight is never interrupted, and neither is digging out: there is no running from a hole.
    if (threat && !['hide', 'dig_out'].includes(memory.job ?? '')) return { stop: 'threat' };
    if (storm && !['hide', 'go_home', 'wait'].includes(memory.job ?? '')) return { stop: 'storm' };
    // Hunger never interrupts a flight: danger outranks it, as in pickJob.
    if (satiety !== null && satiety < HUNGRY && !['eat', 'hide'].includes(memory.job ?? '')) return { stop: 'hungry' };
    return { wait: `letting ${active.kind} finish` };
  }
  if (memory.pit) {
    memory.job = 'dig_out';
    return { start: 'dig_out', args: { x: memory.pit.x, z: memory.pit.z }, why: 'in a hole' };
  }
  const k = kit(inventory);
  const home = memory.home;
  const job = pickJob({
    threat: !!threat,
    storm,
    hunger: satiety,
    night: isNight(environment),
    home: !!home,
    atHome: !!home && horizontal(state.position, home) < 8,
    burrowed: !!memory.burrow,
    dangerHere: memory.scares.filter(scare => horizontal(state.position, scare) <= DANGER_RADIUS).length >= DANGER_SCARES,
    sticks: k.sticks,
    knife: k.knife,
    axe: k.axe,
    shovel: k.shovel,
    stone: k.stone,
    torches: k.torches,
    grass: k.grass,
    dirt: k.dirt,
    logs: k.logs,
  });
  if ((memory.cool.get(job) ?? 0) > now) return { wait: `${job} cooling down` };
  const start = (goal: string, args: Record<string, unknown>, why: string): Decision => {
    memory.job = job;
    return { start: goal, args, why };
  };
  switch (job) {
    case 'wait':
      return { wait: storm ? 'storm' : memory.burrow ? 'night, dug in' : 'night, nowhere to go' };
    case 'burrow':
      return start('burrow', {}, 'night with no home');
    case 'unburrow':
      return start('dig_area', { cells: [memory.burrow], timeoutMs: 120000 }, 'morning, opening the burrow');
    case 'hide': {
      memory.scares.push({ x: state.position.x, z: state.position.z, at: now });
      const away = fleeTarget(state.position, threat);
      return start(
        'travel',
        { x: away.x, z: away.z, arrivalRadius: 3, timeoutMs: 600000 },
        `${threat.code} at ${Math.round(horizontal(state.position, threat.point))} blocks`,
      );
    }
    case 'relocate': {
      const away = fleeTarget(
        state.position,
        memory.scares.map(scare => ({ point: { x: scare.x, y: state.position.y, z: scare.z } })),
        RELOCATE_DISTANCE,
      );
      return start(
        'travel',
        { x: away.x, z: away.z, arrivalRadius: 4, manageFood: true, timeoutMs: 900000 },
        `${memory.scares.length} scares around here; moving on`,
      );
    }
    case 'go_home':
      return start('travel', { x: home!.x, z: home!.z, arrivalRadius: 3, timeoutMs: 600000 }, storm ? 'storm coming' : 'night falling');
    case 'eat':
      return k.reserve > 0
        ? start('eat', {}, `satiety ${Math.round((satiety ?? 0) * 100)}%`)
        : start('forage', { timeoutMs: 1800000 }, `satiety ${Math.round((satiety ?? 0) * 100)}%, nothing carried`);
    case 'dirt':
      return start(
        'harvest',
        { match: 'soil-', item: 'soil-', count: Math.max(1, SHELTER_DIRT - k.dirt), tool: 'Shovel', timeoutMs: 900000 },
        `${k.dirt}/${SHELTER_DIRT} dirt for a shelter`,
      );
    case 'seal':
      return start('harvest', { match: 'soil-', item: 'soil-', count: 2, timeoutMs: 300000 }, 'a block to seal a burrow with');
    case 'shelter':
      return start('shelter', { item: k.dirtCode ?? 'soil-', timeoutMs: 1800000 }, `${k.dirt} dirt, putting up a shelter`);
    case 'sticks':
      if (memory.sticksFromLeaves)
        return start(
          'harvest',
          { match: 'leaves', item: 'game:stick', count: STICK_MIN - k.sticks, timeoutMs: 600000 },
          'no loose sticks about; breaking leaves for them',
        );
      return start(
        'gather',
        { match: 'stick', item: 'game:stick', count: STICK_MIN - k.sticks, timeoutMs: 600000 },
        `${k.sticks}/${STICK_MIN} sticks`,
      );
    case 'stone':
      return start('harvest', { match: 'loosestone', item: 'stone-', count: 2, timeoutMs: 600000 }, 'no stone to knap');
    case 'tools':
      if (!k.knife)
        return k.knifeBlade < 1
          ? start('knap', { output: KNIFE_BLADE, timeoutMs: 600000 }, 'no knife')
          : start('craft_item', { output: KNIFE, count: 1, timeoutMs: 300000 }, 'haft the knife blade');
      if (!k.axe)
        return k.axeBlade < 1
          ? start('knap', { output: AXE_BLADE, timeoutMs: 600000 }, 'no axe')
          : start('craft_item', { output: AXE, count: 1, timeoutMs: 300000 }, 'haft the axe head');
      return k.shovelBlade < 1
        ? start('knap', { output: SHOVEL_BLADE, timeoutMs: 600000 }, 'no shovel')
        : start('craft_item', { output: SHOVEL, count: 1, timeoutMs: 300000 }, 'haft the shovel head');
    case 'grass':
      return start('harvest', { match: 'tallgrass', item: 'drygrass', count: 4, timeoutMs: 600000 }, 'grass for torches');
    case 'torches':
      return start(
        'craft_item',
        { output: TORCH, count: Math.max(1, TORCH_MIN - k.torches), timeoutMs: 300000 },
        `${k.torches}/${TORCH_MIN} torches`,
      );
    case 'logs':
      return start('fell_tree', { count: Math.max(1, LOG_MIN - k.logs), timeoutMs: 1200000 }, `${k.logs}/${LOG_MIN} logs`);
    case 'explore':
      return start('explore', { legs: 2, timeoutMs: 600000 }, 'kit done, looking around');
    default:
      return { wait: 'nothing to do' };
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
  return { home: null, cool: new Map(), job: null, pit: null, burrow: null, done: {}, scares: [], sticksFromLeaves: false, resting: false };
}

const brain: Brain<Memory> = {
  name: 'default',
  description:
    'A cautious beginner: runs from monsters, hides at night and in storms, eats when hungry, gathers sticks and stone, ' +
    'knaps a knife and axe, crafts torches, chops logs, builds a small dirt shelter, and looks around when there is nothing else to do.',
  fresh,
  decide,
  wants,
  summary: memory => ({
    home: memory.home,
    burrow: memory.burrow,
    scares: memory.scares.length,
    job: memory.job,
    done: memory.done,
    cooling: [...memory.cool].filter(([, until]) => until > Date.now()).map(([job]) => job),
  }),
};
export default brain;
