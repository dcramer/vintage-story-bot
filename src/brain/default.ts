// The default brain: a cautious beginner (docs/brain.md). It respawns, swims
// for shore, runs from monsters and from anything that hurts it, hides at
// night and in storms, eats when hungry, marks copper it passes, and works
// through the day-1 kit and a tiny dirt shelter in order. No pottery, hunting
// or trading. Pure: decide() reads one Reading and its own memory and returns
// one Decision; the loop in src/runtime/brain.ts does the talking to the game.

import { isDeathMarker } from '../goals/retrieve_body.ts';
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
// With nothing to eat in the pack, start looking while there is still strength to search.
export const PECKISH = 0.4;
export const KNIFE_BLADE = 'game:knifeblade-flint';
export const AXE_BLADE = 'game:axehead-flint';
export const KNIFE = 'game:knife-generic-flint';
export const AXE = 'game:axe-flint';
export const SHOVEL_BLADE = 'game:shovelhead-flint';
export const SHOVEL = 'game:shovel-flint';
export const TORCH = 'game:torch-basic-extinct-up';
// A job that failed is left alone while the bot is still near where it failed, and for a few
// minutes at most; the ladder goes on to the next job meanwhile, so nothing ever idles on it.
export const TRIED_RADIUS = 24;
export const TRIED_MS = 5 * 60 * 1000;
// Night from dusk (the sun's light under 0.4, when drifters come out and the eye
// sees little) to dawn; unknown light counts as day, since
// without a reading the brain cannot call itself home.
export const NIGHT_LIGHT = 0.4;
// Copper lies where its nuggets show; one marker per 32 blocks is enough to find the spot again.
export const COPPER = /nativecopper/;
export const COPPER_TITLE = 'Copper';
export const MARKER_RADIUS = 32;
// Three scares within this many blocks in this long make a place worth leaving, by this far.
export const DANGER_SCARES = 3;
export const DANGER_RADIUS = 48;
export const DANGER_MS = 15 * 60 * 1000;
export const RELOCATE_DISTANCE = 96;
// A flight ends when no threat has shown for this long and the scare is this far behind.
export const SAFE_MS = 20000;
export const SAFE_DISTANCE = 16;

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
  | 'relocate'
  | 'recover';
type Cell = { x: number; y: number; z: number };
export type Memory = {
  home: Cell | null;
  // Where and when each job last failed.
  tried: Partial<Record<Job, { x: number; z: number; at: number }>>;
  // The last reading's situation and set-aside jobs, for the task list in status.
  situation: Situation | null;
  tried_now: Job[];
  job: Job | null;
  // Where the last walk was heading when it ended in a pit; dig_out cuts stairs that way.
  pit: { x: number; z: number } | null;
  // The pocket the bot dug in for the night: its mouth cell, to dig open again at dawn.
  burrow: { x: number; y: number; z: number } | null;
  done: Record<string, number>;
  // Where and when the bot had to run; a cluster of these around it means this is a bad place to be.
  scares: { x: number; z: number; at: number }[];
  resting: boolean;
  // Sighting keys already marked on the map, so one nugget is announced once.
  marked: Set<string>;
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
  hurt: boolean;
  storm: boolean;
  hunger: number | null;
  reserve: number;
  night: boolean;
  home: boolean;
  atHome: boolean;
  burrowed: boolean;
  dangerHere: boolean;
  // A death marker is on the map: the body's things lie there.
  body: boolean;
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
// The day-1 list, in dependency order: each task is done when the kit shows
// it, and the first task not done is the one to work on. The order carries
// the dependencies (a tool needs a stick and a head; dirt needs a shovel; a
// shelter needs dirt; torches need a home to light), and `after` names them
// so the list can say what a task waits on.
export type Task = { id: Job; title: string; done: (s: Situation) => boolean; after?: Job[] };
export const TASKS: Task[] = [
  { id: 'recover', title: 'my things from where I died', done: s => !s.body },
  { id: 'sticks', title: `${STICK_MIN} sticks`, done: s => s.sticks >= STICK_MIN },
  { id: 'stone', title: 'flint or stone to knap', done: s => s.stone || (s.knife && s.axe && s.shovel) },
  { id: 'tools', title: 'a knife, an axe and a shovel', done: s => s.knife && s.axe && s.shovel, after: ['sticks', 'stone'] },
  { id: 'dirt', title: `${SHELTER_DIRT} dirt for a shelter`, done: s => s.home || s.dirt >= SHELTER_DIRT, after: ['tools'] },
  { id: 'shelter', title: 'a dirt shelter to call home', done: s => s.home, after: ['dirt'] },
  { id: 'grass', title: 'dry grass for torches', done: s => s.torches >= TORCH_MIN || s.grass > 0, after: ['shelter'] },
  { id: 'torches', title: `${TORCH_MIN} torches`, done: s => s.torches >= TORCH_MIN, after: ['grass'] },
  { id: 'logs', title: `${LOG_MIN} logs`, done: s => s.logs >= LOG_MIN, after: ['torches'] },
];
export type TaskState = 'done' | 'next' | 'open' | 'set aside';
// The list as the brain sees it now: what is done, what is next, what waits.
export function tasks(s: Situation, tried: Set<Job> = new Set()): { id: Job; title: string; state: TaskState }[] {
  let next: Job | null = null;
  return TASKS.map(task => {
    let state: TaskState = task.done(s) ? 'done' : tried.has(task.id) ? 'set aside' : 'open';
    if (state === 'open' && !next) {
      next = task.id;
      state = 'next';
    }
    return { id: task.id, title: task.title, state };
  });
}
export function pickJob(s: Situation, tried: Set<Job> = new Set()): Job {
  if (s.threat || s.hurt) return 'hide';
  if (s.storm) return s.home && !s.atHome ? 'go_home' : 'wait';
  // Something from the pack is eaten anywhere, any time; looking for food is daywork.
  if (s.hunger !== null && s.hunger < HUNGRY && s.reserve > 0) return 'eat';
  // A place that keeps producing scares is left behind, day or night, before anything else here.
  if (s.dangerHere && !s.burrowed) return 'relocate';
  if (s.night) return s.home ? (s.atHome ? 'wait' : 'go_home') : s.burrowed ? 'wait' : s.dirt > 0 ? 'burrow' : 'seal';
  if (s.burrowed) return 'unburrow';
  if (s.hunger !== null && (s.hunger < HUNGRY || (s.hunger < PECKISH && s.reserve <= 0))) return 'eat';
  // The first task on the list not done and not set aside around here; with none left, look around.
  return tasks(s, tried).find(task => task.state === 'next')?.id ?? 'explore';
}

// Where to run when hit by something unseen: home if it is not right here, else straight ahead.
export function escapePoint(position: Cell, yawDegrees: number, home: Cell | null) {
  if (home && horizontal(position, home) > 8) return { x: home.x, z: home.z };
  const yaw = (yawDegrees * Math.PI) / 180;
  return { x: position.x + Math.sin(yaw) * 24, z: position.z + Math.cos(yaw) * 24 };
}
// In deep water: face the nearest dry ground and swim with the jump key held, one stroke per decision.
export function surfacing(state: any, ground: Cell | null): Decision {
  const p = state.position;
  const yaw = ground ? ((Math.atan2(ground.x - p.x, ground.z - p.z) * 180) / Math.PI + 360) % 360 : (state.orientation?.yawDegrees ?? 0);
  const oxygen = Math.round(((state.vitals?.oxygen?.current ?? 0) / (state.vitals?.oxygen?.max || 1)) * 100);
  return {
    act: [
      { action: 'look', yawDegrees: yaw, pitchDegrees: 0 },
      { action: 'move', durationMs: 1500, direction: 'forward', jump: true, sprint: false, sneak: false },
    ],
    why: `swimming ${ground ? `toward ${Math.round(ground.x)},${Math.round(ground.z)}` : 'ahead'}, oxygen ${oxygen}%`,
  };
}

export function decide(reading: Reading, memory: Memory): Decision {
  const { state, inventory, environment, active, last, now, events = [], markers = [], ground = null } = reading;
  // Bookkeeping for the brain's own goal that just ended.
  if (last) {
    if (last.ok) memory.done[last.kind] = (memory.done[last.kind] ?? 0) + 1;
    // A walk that ended in a hole is not a failed job: the hole is dealt with first.
    if (last.reason === 'pit' && last.result?.position) memory.pit = { x: last.result.position.x + 8, z: last.result.position.z };
    // Running away is tried again at once, and a job the surroundings refused before it began (water, lost
    // controls) is not the job's fault; every other failed job is set aside around here for a while.
    else if (!last.ok && memory.job && !['hide', 'dig_out'].includes(memory.job) && !/interruption|^brain:/.test(last.reason ?? ''))
      memory.tried[memory.job] = { x: state.position.x, z: state.position.z, at: now };
    if (memory.job === 'dig_out') memory.pit = null;
    // A finished shelter is home.
    if (memory.job === 'shelter' && last.ok && last.result?.home) memory.home = last.result.home;
    if (memory.job === 'burrow' && last.ok && last.result?.mouth) memory.burrow = last.result.mouth;
    if (memory.job === 'unburrow' && last.ok) memory.burrow = null;
    // Whatever the trip's outcome, this place has been judged; judge the new one afresh.
    if (memory.job === 'relocate') memory.scares = [];
    memory.job = null;
  }
  if (memory.resting) return { wait: 'resting after too many scares' };
  memory.scares = memory.scares.filter(scare => now - scare.at < DANGER_MS);
  // Dead: respawn when the server offers it; nothing else matters until then.
  if (!state.alive && active) return { stop: 'dead' };
  if (!state.alive)
    return state.life?.deathId
      ? { act: [{ action: 'respawn', deathId: state.life.deathId }], why: 'dead' }
      : { wait: 'dead, no respawn offered yet' };
  const threat = nearestThreat(state);
  // A hit with no attacker in sight is still danger.
  const hurt = events.some(e => e.type === 'hurt');
  // Copper seen in passing: a marker and a word to the others, once per nugget, unless one is already marked nearby.
  const copper = events.find(e => e.type === 'sighted' && e.kind === 'block' && COPPER.test(e.code ?? '') && !memory.marked.has(e.key));
  if (copper && !threat && !hurt) {
    memory.marked.add(copper.key);
    const x = Math.floor(copper.point.x),
      y = Math.floor(copper.point.y),
      z = Math.floor(copper.point.z);
    if (!markers.some(m => m.title === COPPER_TITLE && horizontal(m.position, copper.point) < MARKER_RADIUS))
      return {
        act: [
          { action: 'add_map_waypoint', title: COPPER_TITLE, x, y, z, icon: 'rocks', color: '#ff8800' },
          { action: 'chat', message: `Found copper at ${x}, ${z}.` },
        ],
        why: `${copper.code} sighted`,
      };
  }
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
    if ((threat || hurt) && !['hide', 'dig_out'].includes(memory.job ?? '')) return { stop: threat ? 'threat' : 'hurt' };
    // A flight is over once nothing has been seen or heard for a while and the scare is well behind.
    const scare = memory.scares.at(-1);
    if (memory.job === 'hide' && !threat && !hurt && scare && now - scare.at > SAFE_MS && horizontal(state.position, scare) >= SAFE_DISTANCE)
      return { stop: 'safe' };
    // Someone else's goal is otherwise left alone; storms and hunger cut short only the brain's own.
    if (active.by !== 'brain') return { wait: `letting ${active.kind} finish (${active.by})` };
    if (storm && !['hide', 'go_home', 'wait'].includes(memory.job ?? '')) return { stop: 'storm' };
    // Hunger never interrupts a flight: danger outranks it, as in pickJob.
    if (satiety !== null && satiety < HUNGRY && !['eat', 'hide'].includes(memory.job ?? '')) return { stop: 'hungry' };
    return { wait: `letting ${active.kind} finish` };
  }
  // Deep water with nothing running: swim for shore before anything else.
  if (state.motion?.swimming) return surfacing(state, ground);
  if (memory.pit) {
    memory.job = 'dig_out';
    return { start: 'dig_out', args: { x: memory.pit.x, z: memory.pit.z }, why: 'in a hole' };
  }
  const k = kit(inventory);
  const home = memory.home;
  const tried = new Set<Job>(
    (Object.entries(memory.tried) as [Job, { x: number; z: number; at: number }][])
      .filter(([, where]) => now - where.at < TRIED_MS && horizontal(state.position, where) <= TRIED_RADIUS)
      .map(([job]) => job),
  );
  const situation: Situation = {
    threat: !!threat,
    hurt,
    storm,
    hunger: satiety,
    reserve: k.reserve,
    night: isNight(environment),
    home: !!home,
    atHome: !!home && horizontal(state.position, home) < 8,
    burrowed: !!memory.burrow,
    dangerHere: memory.scares.filter(scare => horizontal(state.position, scare) <= DANGER_RADIUS).length >= DANGER_SCARES,
    body: markers.some(isDeathMarker),
    sticks: k.sticks,
    knife: k.knife,
    axe: k.axe,
    shovel: k.shovel,
    stone: k.stone,
    torches: k.torches,
    grass: k.grass,
    dirt: k.dirt,
    logs: k.logs,
  };
  memory.situation = situation;
  memory.tried_now = [...tried];
  const job = pickJob(situation, tried);
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
      const away = threat ? fleeTarget(state.position, threat) : escapePoint(state.position, state.orientation?.yawDegrees ?? 0, home);
      return start(
        'travel',
        { x: away.x, z: away.z, arrivalRadius: 8, sprint: true, timeoutMs: 600000 },
        threat ? `${threat.code} at ${Math.round(horizontal(state.position, threat.point))} blocks` : 'hurt by something unseen',
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
        { x: away.x, z: away.z, arrivalRadius: 8, manageFood: true, timeoutMs: 900000 },
        `${memory.scares.length} scares around here; moving on`,
      );
    }
    case 'go_home':
      return start('travel', { x: home!.x, z: home!.z, arrivalRadius: 3, timeoutMs: 600000 }, storm ? 'storm coming' : 'night falling');
    case 'eat':
      return k.reserve > 0
        ? start('eat', {}, `satiety ${Math.round((satiety ?? 0) * 100)}%`)
        : start('forage', { until: 0.5, keep: 160, timeoutMs: 1800000 }, `satiety ${Math.round((satiety ?? 0) * 100)}%, nothing carried`);
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
    case 'recover':
      return start('retrieve_body', { manageFood: true, timeoutMs: 900000 }, 'going back for my things');
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
  // Berries on a bush are always worth a stop.
  list.push('fruitingbush');
  if (k.sticks < STICK_MIN) list.push('stick');
  if ((!k.knife || !k.axe) && !k.stone) list.push('flint', 'loosestones');
  return list;
}

export function fresh(): Memory {
  return {
    home: null,
    tried: {},
    situation: null,
    tried_now: [],
    marked: new Set(),
    job: null,
    pit: null,
    burrow: null,
    done: {},
    scares: [],
    resting: false,
  };
}

const brain: Brain<Memory> = {
  name: 'default',
  description:
    'A cautious beginner: respawns, swims for shore, runs from monsters and from whatever hurts it, hides at night and in storms, eats when hungry, marks copper it passes, gathers sticks and stone, ' +
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
    tried: memory.tried,
    tasks: memory.situation ? tasks(memory.situation, new Set(memory.tried_now)) : [],
  }),
};
export default brain;
