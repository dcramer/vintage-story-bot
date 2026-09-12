// The default brain: a cautious beginner (docs/brain.md). It respawns, swims
// for shore, runs from monsters and from anything that hurts it, hides at
// night and in storms, eats when hungry, marks copper it passes, and works
// through the day-1 kit and a tiny dirt shelter in order. No pottery, hunting
// or trading. Pure: decide() reads one Reading and its own memory and returns
// one Decision; the loop in src/runtime/brain.ts does the talking to the game.

import { dugInState } from '../goals/burrow.ts';
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
// Home is mirrored on the map for the operator and the others; a marker this far from the note is stale.
export const HOME_TITLE = 'Home';
export const HOME_MARKER_RADIUS = 4;
// Three scares within this many blocks in this long make a place worth leaving, by this far.
export const DANGER_SCARES = 3;
export const DANGER_RADIUS = 48;
export const DANGER_MS = 15 * 60 * 1000;
export const RELOCATE_DISTANCE = 96;
// The stones that knap, as the game names them.
export const KNAPPABLE = ['chert', 'granite', 'andesite', 'basalt', 'obsidian', 'peridotite'];
// Jobs that cut a lesser running job short when the ladder turns to them.
// Waiting is never pressing: a wait never cuts a bite or a walk short.
const URGENT: Job[] = ['hide', 'go_home', 'eat', 'relocate', 'burrow'];
// A flight ends when no threat has shown for this long and the scare is this far behind.
export const SAFE_MS = 20000;
export const SAFE_DISTANCE = 16;
// Hurt arrives before the server notification that identifies its cause. Give
// gravity a fraction of a second to identify itself before abandoning useful work.
export const HURT_CLASSIFY_MS = 750;

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
  | 'relocate'
  | 'recover';
type Cell = { x: number; y: number; z: number };
// What is kept between runs: the decisions made about this world, never what was seen.
export type Notes = {
  home: Cell | null;
};
export type Memory = {
  notes: Notes;
  // The Home marker was put on the map, or found there, for the home in the notes.
  homeMarked: boolean;
  // Where and when each job last failed.
  tried: Partial<Record<Job, { x: number; z: number; at: number }>>;
  // The last reading's situation and set-aside jobs, for the task list in status.
  situation: Situation | null;
  tried_now: Job[];
  job: Job | null;
  // Where the last walk was heading when it ended in a pit; dig_out cuts stairs that way.
  pit: { x: number; y: number; z: number } | null;
  // The pocket the bot dug in for the night: its mouth cell, to dig open again at dawn.
  burrow: { x: number; y: number; z: number } | null;
  // Physical burrow recovery is only valid before this controller has moved.
  startupChecked: boolean;
  done: Record<string, number>;
  // Where and when the bot had to run; a cluster of these around it means this is a bad place to be.
  scares: { x: number; z: number; at: number }[];
  // The predator that caused the current goal to be cancelled, retained for the handoff into flight.
  lastThreat: { point: Cell; code: string; at: number } | null;
  resting: boolean;
  // A raw hit waiting briefly for the server's cause notification.
  pendingHurtAt: number | null;
  // Sighting keys already marked on the map, so one nugget is announced once.
  marked: Set<string>;
};

export const isNight = (environment: any) => typeof environment?.calendar?.daylight === 'number' && environment.calendar.daylight < NIGHT_LIGHT;

// The knappable material carried, as the game names tool heads after it: flint, or a rock type.
export function knapMaterial(slots: any[]): string | null {
  const stone = slots.find(s => s.code && kinds.knapping.materials(s));
  if (!stone) return null;
  return stone.code === 'game:flint' ? 'flint' : (stone.code.match(/^game:stone-([a-z]+)$/)?.[1] ?? null);
}
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
    // Tool heads of any knappable material; the material carried names the head to knap and the tool to haft.
    shovelBlade: part('game:shovelhead-'),
    knifeBlade: part('game:knifeblade-'),
    axeBlade: part('game:axehead-'),
    material: knapMaterial(slots),
    heads: slots.map(s => s.code).filter(code => /^game:(knifeblade|axehead|shovelhead)-/.test(code ?? '')) as string[],
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
export type TaskState = 'done' | 'next' | 'open' | 'set aside' | 'waiting';
// The list as the brain sees it now: what is done, what is next, what waits.
export function tasks(s: Situation, tried: Set<Job> = new Set()): { id: Job; title: string; state: TaskState }[] {
  let next: Job | null = null;
  const finished = new Set(TASKS.filter(task => task.done(s)).map(task => task.id));
  return TASKS.map(task => {
    let state: TaskState = task.done(s)
      ? 'done'
      : tried.has(task.id)
        ? 'set aside'
        : (task.after ?? []).some(id => !finished.has(id))
          ? 'waiting'
          : 'open';
    if (state === 'open' && !next) {
      next = task.id;
      state = 'next';
    }
    return { id: task.id, title: task.title, state };
  });
}
export function pickJob(s: Situation, tried: Set<Job> = new Set()): Job {
  // A sealed burrow is already the safest response to something prowling
  // outside. Opening it to flee turns cover into a trap; only actual damage
  // proves the shelter is unsafe. Open the mouth before trying to travel from
  // two blocks underground; the existing pit escape then gets it outside.
  if (s.hurt && s.burrowed) return 'unburrow';
  if (s.threat && s.burrowed && !s.hurt) return 'wait';
  if (s.hurt) return 'hide';
  // A hostile that cannot be run from (across water, on a ledge) is not run from again at once.
  if (s.threat && !tried.has('hide')) return 'hide';
  // Below the recovery threshold, food is no longer optional daywork. With
  // nothing in the pack, sheltering through the night guarantees starvation;
  // keep searching and let forage's own threat handling decide when to run.
  // Dug in with food in the pack, it eats where it sits; with none, it must dig out to look.
  if (s.hunger !== null && s.hunger < HUNGRY) return s.burrowed && s.reserve <= 0 ? 'unburrow' : 'eat';
  if (s.storm) {
    if (s.home) return s.atHome ? 'wait' : 'go_home';
    if (s.burrowed) return 'wait';
    return tried.has('burrow') ? 'wait' : 'burrow';
  }
  // A place that keeps producing scares is left behind, day or night, before anything else here.
  if (s.dangerHere && !s.burrowed) return 'relocate';
  if (s.night) {
    if (s.home) return s.atHome ? 'wait' : 'go_home';
    if (s.burrowed) return 'wait';
    // Dig in where it stands; what it digs seals the hole. A dig-in that failed here is not tried again at once.
    return tried.has('burrow') ? 'wait' : 'burrow';
  }
  // Opening the burrow is a job like the others: set aside when it fails, forgotten when the burrow is far away.
  if (s.burrowed && !tried.has('unburrow')) return 'unburrow';
  if (s.hunger !== null && s.hunger < PECKISH && s.reserve <= 0) return 'eat';
  // The first task on the list not done and not set aside around here; with none left, look around.
  return tasks(s, tried).find(task => task.state === 'next')?.id ?? 'explore';
}

// Where to run when hit by something unseen: home if it is not right here, else straight ahead.
export function escapePoint(position: Cell, yawDegrees: number, home: Cell | null) {
  if (home && horizontal(position, home) > 8) return { x: home.x, z: home.z };
  const yaw = (yawDegrees * Math.PI) / 180;
  return { x: position.x + Math.sin(yaw) * 24, z: position.z + Math.cos(yaw) * 24 };
}
export const environmentalHurt = (events: any[]) =>
  events.some(event => event.type === 'message' && /^Lost [\d.]+ hp through gravity$/i.test(event.text ?? ''));
// In water: face the nearest dry ground and move with the jump key held, one stroke per decision.
export function surfacing(state: any, ground: Cell | null): Decision {
  const p = state.position;
  const yaw = ground ? ((Math.atan2(ground.x - p.x, ground.z - p.z) * 180) / Math.PI + 360) % 360 : (state.orientation?.yawDegrees ?? 0);
  const oxygen = Math.round(((state.vitals?.oxygen?.current ?? 0) / (state.vitals?.oxygen?.max || 1)) * 100);
  const movement = state.motion?.swimming ? 'swimming' : 'wading';
  return {
    act: [
      { action: 'look', yawDegrees: yaw, pitchDegrees: 0 },
      { action: 'move', durationMs: 1500, direction: 'forward', jump: true, sprint: false, sneak: false },
    ],
    why: `${movement} ${ground ? `toward ${Math.round(ground.x)},${Math.round(ground.z)}` : 'ahead'}, oxygen ${oxygen}%`,
  };
}

export function decide(reading: Reading, memory: Memory): Decision {
  const { state, inventory, environment, active, last, now, events = [], markers = [], ground = null } = reading;
  // Bookkeeping for the brain's own goal that just ended.
  if (last) {
    if (last.ok) memory.done[last.kind] = (memory.done[last.kind] ?? 0) + 1;
    // A walk that ended in a hole is not a failed job: the hole is dealt with first.
    if (last.reason === 'pit' && last.result?.position)
      memory.pit = { x: last.result.position.x + 8, y: last.result.position.y, z: last.result.position.z };
    // Running away is tried again at once, and a job the surroundings refused before it began (water, lost
    // controls) is not the job's fault. A body recovery interrupted by danger is different: immediately
    // returning to the same grave makes the fresh life repeat the death, so leave it alone for a while.
    else if (
      !last.ok &&
      memory.job &&
      // A dig-out that climbed is progress worth repeating; one that did not is set aside like any job.
      // A flight that ended stuck (nowhere to run) is set aside too, so an unreachable hostile
      // does not keep the bot from eating; one cut short by the brain itself is not.
      !(memory.job === 'dig_out' && (last.result ? last.result.climbed > 0 : !!memory.pit && state.position.y > memory.pit.y + 0.5)) &&
      (!/interruption|^brain:|^Start grounded$/.test(last.reason ?? '') ||
        (memory.job === 'recover' && /^brain: (threat|hurt|relocate)$/.test(last.reason ?? '')))
    )
      memory.tried[memory.job] = { x: state.position.x, z: state.position.z, at: now };
    // A partial staircase is useful progress and keeps the pit; a run whose result says it
    // climbed nothing forgets it, whatever the height, or the same failing dig-out would
    // restart every tick (the next walk that ends in a hole names the pit again). Only when
    // an action error omits the result altogether is the observed height taken as progress.
    if (memory.job === 'dig_out') {
      const climbed = last.result ? last.result.climbed > 0 : !!memory.pit && state.position.y > memory.pit.y + 0.5;
      if (last.ok || !climbed) memory.pit = null;
    }
    // A finished shelter is home.
    if (memory.job === 'shelter' && last.ok && last.result?.home) setHome(memory, last.result.home);
    if (memory.job === 'burrow' && last.ok && last.result?.mouth) memory.burrow = last.result.mouth;
    if (memory.job === 'unburrow' && last.ok) {
      // Removing the seal opens the shaft but does not put the body back on
      // the surface. Hand the existing dig-out goal an arbitrary direction
      // for its staircase before resuming food or kit work.
      memory.burrow = null;
      memory.pit = { x: state.position.x + 8, y: state.position.y, z: state.position.z };
    }
    // A burrow that could not be opened is not the place to keep coming back to.
    if (memory.job === 'unburrow' && !last.ok) memory.burrow = null;
    // Whatever the trip's outcome, this place has been judged; judge the new one afresh.
    if (memory.job === 'relocate') memory.scares = [];
    memory.job = null;
  }
  if (memory.resting) return { wait: 'resting after too many scares' };
  memory.scares = memory.scares.filter(scare => now - scare.at < DANGER_MS);
  // Dead: respawn when the server offers it; nothing else matters until then.
  // A respawn moves the character independently of the place it died. Forget
  // transient terrain state so the next live reading inspects the new spawn
  // instead of treating it as the old burrow or pit.
  if (!state.alive) {
    memory.burrow = null;
    memory.pit = null;
    memory.startupChecked = false;
    memory.pendingHurtAt = null;
  }
  if (!state.alive && active) return { stop: 'dead' };
  if (!state.alive && temporalStormUnsafe(state)) return { wait: 'dead, waiting out temporal storm' };
  if (!state.alive)
    return state.life?.deathId && state.life?.canRespawn
      ? { act: [{ action: 'respawn', deathId: state.life.deathId }], why: 'dead' }
      : { wait: 'dead, waiting for respawn' };
  // A world still loading, a menu or a dialog: no goal can begin, and one refused
  // before it began would only be started again at once. Wait for the controls.
  if (state.controlReady === false) return { wait: 'controls not ready (loading, menu or dialog)' };
  // Brain memory is deliberately fresh on each controller process, but a
  // completed burrow is durable world state. Recover its mouth from the
  // observed shaft before choosing work, and treat an already-open shaft as
  // a pit to climb out of in safe daylight.
  if (!memory.startupChecked) {
    const bx = Math.floor(state.position.x),
      by = Math.floor(state.position.y),
      bz = Math.floor(state.position.z),
      wet = state.motion?.swimming || state.motion?.feetInLiquid;
    if (
      !wet &&
      reading.terrain &&
      ![
        [bx, by + 1, bz],
        [bx, by + 2, bz],
        [bx + 1, by + 2, bz],
        [bx - 1, by + 2, bz],
        [bx, by + 2, bz + 1],
        [bx, by + 2, bz - 1],
      ].every(([x, y, z]) => reading.terrain.get(x, y, z))
    )
      return { wait: 'inspecting surroundings after startup' };
    memory.startupChecked = true;
    const observedShaft = !wet && reading.terrain ? dugInState(reading.terrain, bx, by, bz) : null;
    if (observedShaft === 'sealed' || (observedShaft === 'open' && (isNight(environment) || temporalStormUnsafe(state))))
      memory.burrow = { x: bx, y: by + 2, z: bz };
    if (observedShaft === 'open' && !memory.burrow) memory.pit = { x: state.position.x + 8, y: state.position.y, z: state.position.z };
  }
  const threat = nearestThreat(state);
  if (threat) memory.lastThreat = { point: threat.point, code: threat.code, at: now };
  // A predator can leave the observation radius while its cancellation is
  // completing. Carry that exact threat through the next decision so the
  // cancelled job becomes a flight instead of immediately restarting work.
  const rememberedThreat =
    last?.reason === 'brain: threat' && memory.lastThreat && now - memory.lastThreat.at < SAFE_MS
      ? { point: memory.lastThreat.point, code: memory.lastThreat.code }
      : null;
  const danger = threat ?? rememberedThreat;
  // A hit with no attacker in sight is still danger. The server also advances
  // lastDamageAt for falls and for the mildly poisonous food authorized during
  // starvation; their notifications identify the cause, so neither is an attacker.
  // The event cursor advances when the running goal is stopped. Carry the
  // stop reason into this decision so a one-tick hit actually starts a flight
  // instead of cancelling work and immediately restarting the same job.
  const poisonFromFood =
    memory.job === 'eat' && events.some(event => event.type === 'message' && /^Lost [\d.]+ hp through poison$/i.test(event.text ?? ''));
  const explainedHurt = environmentalHurt(events) || poisonFromFood;
  // Max-health nutrition drift can lower current and maximum health together.
  // The bridge reports that as a hurt event even though the bar remains full;
  // only a real deficit is evidence of damage from something unseen.
  const health = state.vitals?.health,
    fullHealth = Number.isFinite(health?.current) && Number.isFinite(health?.max) && health.current >= health.max - 0.01,
    rawHurt = !fullHealth && events.some(e => e.type === 'hurt');
  if (explainedHurt || danger) memory.pendingHurtAt = null;
  else if (rawHurt && memory.pendingHurtAt === null) memory.pendingHurtAt = now;
  const pendingHurt = memory.pendingHurtAt !== null && now - memory.pendingHurtAt >= HURT_CLASSIFY_MS;
  // A known nearby threat removes the need to wait for a cause notification.
  // This matters inside a burrow: merely hearing a creature outside is safe,
  // but losing health while it is nearby proves the pocket is compromised.
  const hurt = !explainedHurt && (last?.reason === 'brain: hurt' || pendingHurt || (rawHurt && !!danger));
  const classifyingHurt = !explainedHurt && !danger && memory.pendingHurtAt !== null && !pendingHurt;
  if (pendingHurt) memory.pendingHurtAt = null;
  // Copper seen in passing: a marker and a word to the others, once per nugget, unless one is already marked nearby.
  const copper = events.find(e => e.type === 'sighted' && e.kind === 'block' && COPPER.test(e.code ?? '') && !memory.marked.has(e.key));
  if (copper && !danger && !hurt && !classifyingHurt) {
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
  const home = memory.notes.home;
  // Home on the map, once per home: the operator and the others find it there, and a home that moved takes its marker along.
  if (home && !memory.homeMarked && !danger && !hurt && !classifyingHurt && state.capabilities?.includes?.('map_waypoint_add')) {
    const marker = markers.find(m => m.title === HOME_TITLE);
    if (marker && horizontal(marker.position, home) <= HOME_MARKER_RADIUS) memory.homeMarked = true;
    else {
      memory.homeMarked = true;
      return {
        act: [
          ...(marker ? [{ action: 'remove_map_waypoint', guid: marker.guid }] : []),
          {
            action: 'add_map_waypoint',
            title: HOME_TITLE,
            x: Math.floor(home.x),
            y: Math.floor(home.y),
            z: Math.floor(home.z),
            icon: 'home',
            color: '#22aa22',
          },
        ],
        why: marker ? 'home moved' : 'home built',
      };
    }
  }
  let satiety: number | null = null;
  try {
    satiety = hunger(state);
  } catch {
    satiety = null;
  }
  const storm = temporalStormUnsafe(state);
  const k = kit(inventory);
  const tried = new Set<Job>(
    (Object.entries(memory.tried) as [Job, { x: number; z: number; at: number }][])
      // Recovery danger belongs to the grave, not the point from which the bot happened to notice it.
      // Keep that cooldown across a flight instead of retrying as soon as it has run 24 blocks away.
      .filter(([job, where]) => now - where.at < TRIED_MS && (job === 'recover' || horizontal(state.position, where) <= TRIED_RADIUS))
      .map(([job]) => job),
  );
  const situation: Situation = {
    threat: !!danger,
    hurt,
    storm,
    hunger: satiety,
    reserve: k.reserve,
    night: isNight(environment),
    home: !!home,
    atHome: !!home && horizontal(state.position, home) < 8,
    burrowed: !!memory.burrow && horizontal(state.position, memory.burrow) <= 8,
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
  // A goal of its own is running. What cuts it short is what the ladder would rather do now:
  // danger first, then a storm, night, a bad place, or food in hand when hungry.
  if (active) {
    // Forage owns a deterministic evade-and-resume loop. Cancelling it on the
    // same sighting throws away its food leads and starts a second flight on
    // top of navigation's evasion, which is especially costly near starvation.
    // Actual damage still interrupts below, as it may be from an unseen source.
    if (danger && !hurt && memory.job === 'eat' && active.kind === 'forage') return { wait: 'letting forage evade threat' };
    // A flight is never interrupted, and neither is digging out: there is no running from a hole.
    // Nor is digging in at night: two blocks down is the safest place from whatever is coming.
    if ((danger || hurt) && !['hide', 'dig_out', 'burrow', 'unburrow'].includes(memory.job ?? '')) return { stop: danger ? 'threat' : 'hurt' };
    if (classifyingHurt) return { wait: 'identifying damage source' };
    // Damage chat can trail the life event by one brain tick. If gravity is
    // identified only after the reflex already launched a flight, end that
    // mistaken flight and return to the interrupted survival job.
    if (memory.job === 'hide' && !danger && environmentalHurt(events)) return { stop: 'fall' };
    // A flight is over once nothing has been seen or heard for a while and the scare is well behind.
    const scare = memory.scares.at(-1);
    if (memory.job === 'hide' && !danger && !hurt && scare && now - scare.at > SAFE_MS && horizontal(state.position, scare) >= SAFE_DISTANCE)
      return { stop: 'safe' };
    // Someone else's goal is otherwise left alone.
    if (active.by !== 'brain') return { wait: `letting ${active.kind} finish (${active.by})` };
    // A recovery run owns food until it reaches its target, even when the last
    // carried bite briefly clears the urgent hunger alert. Cancelling it at
    // that boundary for night shelter leaves the bot peckish and restarts the
    // same forage/burrow cycle a few ticks later.
    if (memory.job === 'eat' && active.kind === 'forage') return { wait: 'letting forage finish' };
    // A dig-in is finished whatever is about: two blocks down is safer than any flight at night.
    const pressing = URGENT.includes(job) && job !== memory.job && !['hide', 'dig_out', 'burrow', 'unburrow'].includes(memory.job ?? '');
    // Peckish is not an interruption; hungry is, and only when the ladder would actually eat.
    if (pressing && (job !== 'eat' || (satiety !== null && satiety < HUNGRY))) return { stop: job };
    return { wait: `letting ${active.kind} finish` };
  }
  if (classifyingHurt) return { wait: 'identifying damage source' };
  // Wet footing cannot gather, craft or dig. Swim or wade to dry ground before choosing work.
  if (state.motion?.swimming || state.motion?.feetInLiquid) return surfacing(state, ground);
  // Stopping a flight can catch the body between a jump and its landing. Every
  // fieldwork goal requires grounded footing, so let physics settle instead of
  // immediately failing the resumed kit job and setting it aside for minutes.
  if (state.motion?.onGround === false) return { wait: 'settling after movement' };
  if (memory.pit) {
    memory.job = 'dig_out';
    return { start: 'dig_out', args: { x: memory.pit.x, z: memory.pit.z }, why: 'in a hole' };
  }
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
      return start(
        'dig_area',
        { cells: [memory.burrow], timeoutMs: 120000 },
        hurt ? 'burrow breached, opening escape' : situation.night ? 'hungry, opening the burrow' : 'morning, opening the burrow',
      );
    case 'hide': {
      memory.scares.push({ x: state.position.x, z: state.position.z, at: now });
      const away = danger ? fleeTarget(state.position, danger) : escapePoint(state.position, state.orientation?.yawDegrees ?? 0, home);
      return start(
        'travel',
        { x: away.x, z: away.z, arrivalRadius: 8, sprint: true, timeoutMs: 600000 },
        danger ? `${danger.code} at ${Math.round(horizontal(state.position, danger.point))} blocks` : 'hurt by something unseen',
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
      // Sealed in for the night: one bite from the pack, no searching.
      if (situation.burrowed && k.reserve > 0) return start('eat', {}, `satiety ${Math.round((satiety ?? 0) * 100)}%, dug in`);
      return start(
        'forage',
        // Fed to half with two bites' worth kept in the pack: the pack is
        // what stops the next peckish tick from starting the same search again.
        { until: PECKISH + 0.1, keep: 160, timeoutMs: 1800000 },
        `satiety ${Math.round((satiety ?? 0) * 100)}%, ${k.reserve > 0 ? `${k.reserve} carried` : 'nothing carried'}`,
      );
    case 'dirt':
      return start(
        'harvest',
        { match: 'soil-', item: 'soil-', count: Math.max(1, SHELTER_DIRT - k.dirt), tool: 'Shovel', timeoutMs: 900000 },
        `${k.dirt}/${SHELTER_DIRT} dirt for a shelter`,
      );
    case 'shelter':
      return start('shelter', { item: k.dirtCode ?? 'soil-', timeoutMs: 1800000 }, `${k.dirt} dirt, putting up a shelter`);
    case 'sticks':
      return start(
        'gather',
        { match: 'stick', item: 'game:stick', count: STICK_MIN - k.sticks, timeoutMs: 600000 },
        `${k.sticks}/${STICK_MIN} sticks`,
      );
    case 'stone':
      // Loose flint is the usual find; a knappable loose stone does as well. Both are right-clicks off the ground.
      return start('gather', { match: 'looseflints', item: 'game:flint', count: 2, timeoutMs: 600000 }, 'flint to knap');
    case 'tools':
      // Heads are knapped from what is carried and hafted into the tool of the same material.
      if (!k.knife)
        return k.knifeBlade < 1
          ? start('knap', { output: `game:knifeblade-${k.material ?? 'flint'}`, timeoutMs: 600000 }, 'no knife')
          : start(
              'craft_item',
              { output: `game:knife-generic-${headMaterial(k, 'knifeblade')}`, count: 1, timeoutMs: 300000 },
              'haft the knife blade',
            );
      if (!k.axe)
        return k.axeBlade < 1
          ? start('knap', { output: `game:axehead-${k.material ?? 'flint'}`, timeoutMs: 600000 }, 'no axe')
          : start('craft_item', { output: `game:axe-${headMaterial(k, 'axehead')}`, count: 1, timeoutMs: 300000 }, 'haft the axe head');
      return k.shovelBlade < 1
        ? start('knap', { output: `game:shovelhead-${k.material ?? 'flint'}`, timeoutMs: 600000 }, 'no shovel')
        : start('craft_item', { output: `game:shovel-${headMaterial(k, 'shovelhead')}`, count: 1, timeoutMs: 300000 }, 'haft the shovel head');
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
  // Food where it grows is always worth a stop: berries on a ripe bush, a
  // mushroom the handbook calls edible, a wild hive's honeycomb.
  list.push('fruitingbush', 'mushroom', 'wildbeehive');
  if (k.sticks < STICK_MIN) list.push('stick');
  // Loose flint, and the loose stones that knap; claystone and the like are not worth a stop.
  if ((!k.knife || !k.axe || !k.shovel) && !k.stone) list.push('looseflints', ...KNAPPABLE.map(rock => `loosestones-${rock}`));
  return list;
}

// The material of a carried tool head, from its code (game:knifeblade-flint -> flint).
export function headMaterial(k: ReturnType<typeof kit>, head: string): string {
  return k.heads.find(code => code.startsWith(`game:${head}-`))?.slice(`game:${head}-`.length) ?? k.material ?? 'flint';
}
const cell = (c: any): Cell | null => (c && [c.x, c.y, c.z].every(Number.isFinite) ? { x: c.x, y: c.y, z: c.z } : null);
// Home is a note: it outlives the process, and moving house is rewriting it.
export function setHome(memory: Memory, home: Cell | null) {
  memory.notes.home = cell(home);
  memory.homeMarked = false;
}
export function notes(memory: Memory): Notes {
  return memory.notes;
}
export function fresh(kept?: Partial<Notes> | null): Memory {
  return {
    notes: { home: cell(kept?.home) },
    homeMarked: false,
    tried: {},
    situation: null,
    tried_now: [],
    marked: new Set(),
    job: null,
    pit: null,
    burrow: null,
    startupChecked: false,
    done: {},
    scares: [],
    lastThreat: null,
    resting: false,
    pendingHurtAt: null,
  };
}

const brain: Brain<Memory, Notes> = {
  name: 'default',
  description:
    'A cautious beginner: respawns, swims for shore, runs from monsters and from whatever hurts it, hides at night and in storms, eats when hungry, marks copper it passes, gathers sticks and stone, ' +
    'knaps a knife and axe, crafts torches, chops logs, builds a small dirt shelter, and looks around when there is nothing else to do.',
  fresh,
  decide,
  wants,
  notes,
  summary: memory => ({
    home: memory.notes.home,
    burrow: memory.burrow,
    scares: memory.scares.length,
    job: memory.job,
    done: memory.done,
    tried: memory.tried,
    tasks: memory.situation ? tasks(memory.situation, new Set(memory.tried_now)) : [],
  }),
};
export default brain;
