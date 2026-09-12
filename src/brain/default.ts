// The default brain: a cautious beginner (docs/brain.md). It respawns, swims
// for shore, runs from monsters and from anything that hurts it, hides at
// night and in storms, eats when hungry, marks copper it passes, and works
// through the day-1 kit and a tiny dirt shelter in order. No pottery, hunting
// or trading. Pure: decide() reads one Reading and its own memory and returns
// one Decision; the loop in src/runtime/brain.ts does the talking to the game.
// The parts live in src/brain/default/: this file only orders them.

import { isDeathMarker } from '../goals/retrieve_body.ts';
import type { Brain, Decision, Reading } from '../runtime/brain.ts';
import { horizontal } from '../runtime/navigation/terrain.ts';
import { temporalStormUnsafe } from '../support/fieldwork.ts';
import { hunger } from '../support/food.ts';
import { copper } from './default/alongside/copper.ts';
import { homeMarker } from './default/alongside/home.ts';
import {
  type Aside,
  type Concern,
  type Context,
  cell,
  failedOnItsOwn,
  type Job,
  type Memory,
  type Notes,
  pickJob as pick,
  type Rung,
  stashNote,
  TRIED_MS,
  TRIED_RADIUS,
  tasks as taskList,
} from './default/concern.ts';
import { burrow, recoverBurrow } from './default/reflexes/burrow.ts';
import { digOut } from './default/reflexes/dig_out.ts';
import { eat, hungry, peckish } from './default/reflexes/eat.ts';
import { explore } from './default/reflexes/explore.ts';
import { goHome } from './default/reflexes/go_home.ts';
import { hide } from './default/reflexes/hide.ts';
import { dangerHere, forgetOldScares, relocate } from './default/reflexes/relocate.ts';
import { surfacing } from './default/reflexes/swim.ts';
import { unburrow } from './default/reflexes/unburrow.ts';
import { wait } from './default/reflexes/wait.ts';
import { isNight, kit, type Situation, senseDanger } from './default/situation.ts';
import { bags } from './default/tasks/bags.ts';
import { dirt } from './default/tasks/dirt.ts';
import { grass } from './default/tasks/grass.ts';
import { logs } from './default/tasks/logs.ts';
import { recover } from './default/tasks/recover.ts';
import { resupply, resupplyOf } from './default/tasks/resupply.ts';
import { shelter } from './default/tasks/shelter.ts';
import { spareKnife } from './default/tasks/spare_knife.ts';
import { FULL_SLOTS, stash, surplusOf } from './default/tasks/stash.ts';
import { sticks } from './default/tasks/sticks.ts';
import { storage } from './default/tasks/storage.ts';
import { axe, knife, shovel } from './default/tasks/tools.ts';
import { torches } from './default/tasks/torches.ts';

export { environmentalHurt, HURT_CLASSIFY_MS, kit } from './default/situation.ts';
export { SHELTER_DIRT } from './default/tasks/shelter.ts';
export { STICK_MIN } from './default/tasks/sticks.ts';
export type { Job, Memory, Notes, Situation };

// The list follows getting-started day 1, minus pottery and hunting: knife and
// axe knapped first (each needs only a stick and a flint, so it is made the
// moment both are in hand), two hand baskets worn and the reed chest from
// cattails put down at the site,
// the shovel, then the body if one lies somewhere, dirt and the house before
// dark beside the basket, torches for the night, a backup knife into the
// basket; day 2 chops a tree. Each task is done when the kit or the notes
// show it, and the first task not done is the one to work on; `after` names
// what a task waits on (dirt needs a shovel, a shelter needs dirt, torches
// need a home to light). What the basket holds is fetched before anything is
// gathered; a full pack is emptied before the rest of the list.
export const TASKS: Concern[] = [
  resupply,
  knife,
  axe,
  bags,
  storage,
  shovel,
  recover,
  dirt,
  shelter,
  stash,
  sticks,
  grass,
  torches,
  spareKnife,
  logs,
];
const REFLEXES: Concern[] = [hide, eat, goHome, burrow, unburrow, wait, relocate, digOut, explore];
// What runs beside any job, through tools that only talk.
const ALONGSIDE: Aside[] = [copper, homeMarker];
// The ladder: danger, then hunger, then a storm, a bad place, night, then the
// list. A sealed burrow is already the safest response to something prowling
// outside: opening it to flee turns cover into a trap, and only actual damage
// proves the shelter unsafe. Hungry and dug in with nothing carried, it must
// dig out to look. A hostile that cannot be run from (across water, on a
// ledge) is not run from again at once; a dig-in that failed here is not
// tried again at once either, nor is opening a burrow that would not open.
export const LADDER: Rung[] = [
  { job: 'unburrow', when: s => s.burrowed && s.hurt },
  { job: 'wait', when: s => s.burrowed && s.threat && !s.hurt },
  { job: 'hide', when: (s, tried) => s.hurt || (s.threat && !tried.has('hide')) },
  { job: 'unburrow', when: s => hungry(s) && s.burrowed && s.reserve <= 0 },
  { job: 'eat', when: s => hungry(s) },
  { job: 'go_home', when: s => s.storm && s.home && !s.atHome },
  { job: 'wait', when: (s, tried) => s.storm && ((s.home && s.atHome) || s.burrowed || tried.has('burrow')) },
  { job: 'burrow', when: s => s.storm },
  { job: 'relocate', when: s => s.dangerHere && !s.burrowed },
  { job: 'go_home', when: s => s.night && s.home && !s.atHome },
  { job: 'wait', when: (s, tried) => s.night && ((s.home && s.atHome) || s.burrowed || tried.has('burrow')) },
  { job: 'burrow', when: s => s.night },
  { job: 'unburrow', when: (s, tried) => s.burrowed && !tried.has('unburrow') },
  { job: 'eat', when: (s, tried) => peckish(s) && s.reserve <= 0 && !tried.has('eat') },
];
const CONCERNS = new Map<Job, Concern>([...REFLEXES, ...TASKS].map(concern => [concern.id, concern]));
const concern = (job: Job) => CONCERNS.get(job)!;

export const tasks = (s: Situation, tried: Set<Job> = new Set()) => taskList(TASKS, s, tried);
// A dialog left open by a goal that failed (a recipe selector, the handbook, a container) blocks every control;
// a player presses Escape. Character creation, death and disconnection are not closed this way.
// Escape is pressed at most a few times in a short while, then the wait says what is open.
export const DIALOG_CLOSES = 3;
export const DIALOG_CLOSE_MS = 10000;
export const closableDialog = (dialogs: Reading['dialogs']) =>
  dialogs?.find(d => d.blocksControl && /^GuiDialog(?!CreateCharacter|Dead|Death|Disconnect|Confirm|Login)/.test(d.name))?.name ?? null;
export const pickJob = (s: Situation, tried: Set<Job> = new Set()) => pick(LADDER, TASKS, 'explore', s, tried);

// The jobs set aside around here: failed within a few minutes and, unless the job says
// everywhere, within a few blocks of where it failed.
function triedNow(memory: Memory, position: { x: number; z: number }, now: number) {
  return new Set<Job>(
    (Object.entries(memory.tried) as [Job, { x: number; z: number; at: number }][])
      .filter(([job, where]) => now - where.at < TRIED_MS && (concern(job)?.setAsideEverywhere || horizontal(position, where) <= TRIED_RADIUS))
      .map(([job]) => job),
  );
}

export function decide(reading: Reading, memory: Memory): Decision {
  const { state, inventory, environment, active, last, now, events = [], markers = [], ground = null } = reading;
  // Bookkeeping for the brain's own goal that just ended.
  if (last) {
    if (last.ok) memory.done[last.kind] = (memory.done[last.kind] ?? 0) + 1;
    const mine = memory.job ? concern(memory.job) : null;
    // A walk that ended in a hole is not a failed job: the hole is dealt with first.
    if (last.reason === 'pit' && last.result?.position)
      memory.pit = { x: last.result.position.x + 8, y: last.result.position.y, z: last.result.position.z };
    else if (!last.ok && mine && (mine.setAside ?? failedOnItsOwn)(last, memory, reading))
      memory.tried[mine.id] = { x: state.position.x, z: state.position.z, at: now };
    mine?.ended?.(last, memory, reading);
    memory.job = null;
  }
  if (memory.resting) return { wait: 'resting after too many scares' };
  forgetOldScares(memory, now);
  // Dead: respawn when the server offers it; nothing else matters until then.
  // A respawn moves the character independently of the place it died. Forget
  // transient terrain state so the next live reading inspects the new spawn
  // instead of treating it as the old burrow or pit.
  if (!state.alive) {
    memory.burrow = null;
    memory.pit = null;
    memory.startupChecked = false;
    memory.pendingHurtAt = null;
    if (active) return { stop: 'dead' };
    if (temporalStormUnsafe(state)) return { wait: 'dead, waiting out temporal storm' };
    return state.life?.deathId && state.life?.canRespawn
      ? { act: [{ action: 'respawn', deathId: state.life.deathId }], why: 'dead' }
      : { wait: 'dead, waiting for respawn' };
  }
  // A world still loading, a menu or a dialog: no goal can begin, and one refused
  // before it began would only be started again at once. Wait for the controls.
  if (state.controlReady === false) {
    const closable = closableDialog(reading.dialogs);
    memory.dialogCloses = memory.dialogCloses.filter(at => now - at < DIALOG_CLOSE_MS);
    if (closable && memory.dialogCloses.length < DIALOG_CLOSES) {
      memory.dialogCloses.push(now);
      return { act: [{ action: 'close_dialog' }], why: `${closable} blocks the controls` };
    }
    return { wait: 'controls not ready (loading, menu or dialog)' };
  }
  const startup = recoverBurrow(reading, memory);
  if (startup) return startup;
  const { danger, hurt, classifyingHurt } = senseDanger(reading, memory, !!(memory.job && concern(memory.job).explains?.(events)));
  let satiety: number | null = null;
  try {
    satiety = hunger(state);
  } catch {
    satiety = null;
  }
  const storm = temporalStormUnsafe(state);
  const k = kit(inventory);
  const home = memory.notes.home;
  const tried = triedNow(memory, state.position, now);
  const s: Situation = {
    threat: !!danger,
    hurt,
    storm,
    hunger: satiety,
    reserve: k.reserve,
    night: isNight(environment),
    home: !!home,
    atHome: !!home && horizontal(state.position, home) < 8,
    burrowed: !!memory.burrow && horizontal(state.position, memory.burrow) <= 8,
    dangerHere: dangerHere(memory, state.position),
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
    storage: !!memory.notes.stash,
    bags: k.bags,
    full: k.free <= FULL_SLOTS,
    surplus: surplusOf(k, { home: !!home, torches: k.torches }).reduce((n, i) => n + i.count, 0),
    short: resupplyOf(k, { home: !!home, torches: k.torches }, memory.notes.stash).reduce((n, i) => n + i.count, 0),
    stashKnife: Object.keys(memory.notes.stash?.seen?.items ?? {}).some(code => code.includes('knife-')),
  };
  memory.situation = s;
  memory.tried_now = [...tried];
  const job = pickJob(s, tried);
  const ctx: Context = {
    reading,
    state,
    events,
    markers,
    active,
    now,
    memory,
    s,
    k,
    tried,
    danger,
    hurt,
    classifyingHurt,
    satiety,
    storm,
    home,
    job,
  };
  // Beside any job, when nothing is pressing.
  if (!danger && !hurt && !classifyingHurt)
    for (const aside of ALONGSIDE) {
      const decision = aside.act(ctx);
      if (decision) return decision;
    }
  // A goal of its own is running. What cuts it short is what the ladder would rather do now:
  // danger first, then a storm, night, a bad place, or food in hand when hungry.
  if (active) {
    const mine = memory.job ? concern(memory.job) : null;
    const own = mine?.running?.(ctx);
    if (own) return own;
    if ((danger || hurt) && !mine?.uncuttable) return { stop: danger ? 'threat' : 'hurt' };
    if (classifyingHurt) return { wait: 'identifying damage source' };
    // Someone else's goal is otherwise left alone.
    if (active.by !== 'brain') return { wait: `letting ${active.kind} finish (${active.by})` };
    const cuts = concern(job).cuts;
    const pressing = job !== memory.job && !mine?.uncuttable && (typeof cuts === 'function' ? cuts(ctx) : !!cuts);
    if (pressing) return { stop: job };
    return { wait: `letting ${active.kind} finish` };
  }
  if (classifyingHurt) return { wait: 'identifying damage source' };
  // Wet footing cannot gather, craft or dig. Swim or wade to dry ground before choosing work.
  if (state.motion?.swimming || state.motion?.feetInLiquid) return surfacing(state, ground);
  // Stopping a flight can catch the body between a jump and its landing. Every
  // fieldwork goal requires grounded footing, so let physics settle instead of
  // immediately failing the resumed kit job and setting it aside for minutes.
  if (state.motion?.onGround === false) return { wait: 'settling after movement' };
  // In a hole: out of it before any job.
  if (memory.pit) {
    memory.job = 'dig_out';
    return digOut.run(ctx);
  }
  const decision = concern(job).run(ctx);
  if ('start' in decision) memory.job = job;
  return decision;
}

// What to pick up in passing, whatever the current job: food where it grows, and the kit's shortfalls that lie on the ground.
export function wants(reading: Reading): string[] {
  const k = kit(reading.inventory);
  return [...REFLEXES, ...TASKS].flatMap(concern => concern.wants?.(k) ?? []);
}
export function notes(memory: Memory): Notes {
  return memory.notes;
}
export function fresh(kept?: Partial<Notes> | null): Memory {
  return {
    notes: { home: cell(kept?.home), stash: stashNote(kept?.stash) },
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
    dialogCloses: [],
  };
}

const brain: Brain<Memory, Notes> = {
  name: 'default',
  description:
    'A cautious beginner: respawns, swims for shore, runs from monsters and from whatever hurts it, hides at night and in storms, eats when hungry, marks copper it passes, ' +
    'knaps a knife, an axe and a shovel, weaves hand baskets and a reed chest at its site, builds a small dirt shelter beside it, crafts torches, chops logs, ' +
    'puts the surplus away when its pack is full, and looks around when there is nothing else to do.',
  fresh,
  decide,
  wants,
  notes,
  summary: memory => ({
    home: memory.notes.home,
    stash: memory.notes.stash,
    burrow: memory.burrow,
    scares: memory.scares.length,
    job: memory.job,
    done: memory.done,
    tried: memory.tried,
    tasks: memory.situation ? tasks(memory.situation, new Set(memory.tried_now)) : [],
  }),
};
export default brain;
