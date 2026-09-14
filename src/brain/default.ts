// Early survival decisions over current readings and durable camp notes.
// Concerns own their behavior; this file orders and interrupts them.

import type { Brain, Decision, Reading } from '../runtime/brain.ts';
import { copper } from './default/alongside/copper.ts';
import { homeMarker } from './default/alongside/home.ts';
import { suppliesMarker } from './default/alongside/supplies.ts';
import {
  type Alongside,
  type Concern,
  type Context,
  failedOnItsOwn,
  type Job,
  type Memory,
  type Notes,
  pickJob as pick,
  tasks as taskList,
  workOn,
} from './default/concern.ts';
import { digestReading } from './default/digest.ts';
import { LADDER } from './default/ladder.ts';
import { earlyDecision, readyDecision } from './default/lifecycle.ts';
import { NOTES_VERSION, parseNotes } from './default/notes.ts';
import { burrow } from './default/reflexes/burrow.ts';
import { digOut } from './default/reflexes/dig_out.ts';
import { eat } from './default/reflexes/eat.ts';
import { explore } from './default/reflexes/explore.ts';
import { goHome } from './default/reflexes/go_home.ts';
import { hide } from './default/reflexes/hide.ts';
import { leaveShelter } from './default/reflexes/leave_shelter.ts';
import { relocate } from './default/reflexes/relocate.ts';
import { shift } from './default/reflexes/shift.ts';
import { tunnel } from './default/reflexes/tunnel.ts';
import { unburrow } from './default/reflexes/unburrow.ts';
import { wait } from './default/reflexes/wait.ts';
import { kit, type Situation } from './default/situation.ts';
import { bags } from './default/tasks/bags.ts';
import { dirt } from './default/tasks/dirt.ts';
import { farm } from './default/tasks/farm.ts';
import { grass } from './default/tasks/grass.ts';
import { house } from './default/tasks/house.ts';
import { lighting } from './default/tasks/lighting.ts';
import { logs } from './default/tasks/logs.ts';
import { provisions } from './default/tasks/provisions.ts';
import { recover } from './default/tasks/recover.ts';
import { repairHome } from './default/tasks/repair_home.ts';
import { resupply } from './default/tasks/resupply.ts';
import { shelter } from './default/tasks/shelter.ts';
import { spareKnife } from './default/tasks/spare_knife.ts';
import { stash } from './default/tasks/stash.ts';
import { sticks } from './default/tasks/sticks.ts';
import { stockpile } from './default/tasks/stockpile.ts';
import { storage } from './default/tasks/storage.ts';
import { axe, hoe, knife, shovel } from './default/tasks/tools.ts';
import { torches } from './default/tasks/torches.ts';

export { THREAT_NEAR } from './default/digest.ts';
export { LADDER, STARVING } from './default/ladder.ts';
export { retainedInventory } from './default/lifecycle.ts';
export { environmentalHurt, HURT_CLASSIFY_MS, kit } from './default/situation.ts';
export { SHELTER_DIRT } from './default/tasks/shelter.ts';
export { STICK_MIN } from './default/tasks/sticks.ts';
export type { Job, Memory, Notes, Situation };

// Dependencies are checked against the current kit; interrupted work is re-derived.
export const TASKS: Concern[] = [
  repairHome,
  resupply,
  recover,
  knife,
  axe,
  bags,
  storage,
  stash,
  shovel,
  dirt,
  grass,
  torches,
  shelter,
  house,
  lighting,
  hoe,
  farm,
  sticks,
  spareKnife,
  logs,
  stockpile,
  provisions,
];
const REFLEXES: Concern[] = [leaveShelter, hide, eat, goHome, burrow, unburrow, tunnel, shift, wait, relocate, digOut, explore];
// What runs beside any job, through tools that only talk.
const ALONGSIDE: Alongside[] = [copper, homeMarker, suppliesMarker];
const CONCERNS = new Map<Job, Concern>([...REFLEXES, ...TASKS].map(concern => [concern.id, concern]));
const concern = (job: Job) => CONCERNS.get(job)!;

export const tasks = (s: Situation, tried: Set<Job> = new Set()) => taskList(TASKS, s, tried);
// How long damage the job explained keeps explaining after the job ended.
export const EXPLAINED_MS = 15000;
export const pickJob = (s: Situation, tried: Set<Job> = new Set()) => pick(LADDER, TASKS, 'explore', s, tried);

export function decide(reading: Reading, memory: Memory): Decision {
  const { state, active, last, now, events = [], markers = [] } = reading;
  // Bookkeeping for the brain's own goal that just ended.
  // Damage the job just done explains (poison from a desperate bite) is known before the job is forgotten,
  // and for a while after: the poison outlasts the bite.
  if (memory.job && concern(memory.job).explains?.(events)) memory.explainedUntil = now + EXPLAINED_MS;
  if (last) {
    if (last.ok) memory.done[last.kind] = (memory.done[last.kind] ?? 0) + 1;
    const mine = memory.job ? concern(memory.job) : null;
    // A walk that ended in a hole is not a failed job: the hole is dealt with first. The hole is
    // where the body stands, whether or not the goal's result says so (travel does, others do not).
    // 'pit' is the search loop's own word (support/search.ts), with position and heading in the result.
    if (last.reason === 'pit') {
      const where = last.result?.position ?? state.position;
      const toward = last.result?.toward;
      memory.pit = { x: toward?.x ?? where.x + 8, y: where.y, z: toward?.z ?? where.z, ...(last.result?.covered ? { forced: true } : {}) };
      if (mine?.id !== 'dig_out') memory.pitJob = mine?.id ?? null;
    } else if (!last.ok && mine && (mine.setAside ?? failedOnItsOwn)(last, memory, reading))
      memory.tried[mine.id] = { x: state.position.x, z: state.position.z, at: now };
    mine?.ended?.(last, memory, reading);
    memory.job = null;
  }
  const early = earlyDecision(reading, memory);
  if (early) return early;
  const { s, k, tried, danger, hurt, classifyingHurt, satiety, storm, home, dwelling, inside, sealed } = digestReading(reading, memory, concern);
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
    for (const alongside of ALONGSIDE) {
      const decision = alongside.act(ctx);
      if (decision) return decision;
    }
  // A goal of its own is running. What cuts it short is what the ladder would rather do now:
  // danger first, then a storm, night, a bad place, or food in hand when hungry.
  if (active) {
    // A terrain-aware shore route is the only usable recovery while the feet
    // are wet. Do not let the job ladder cancel and restart it every tick;
    // priorities take over again as soon as the body reaches dry footing.
    if ((state.motion?.swimming || state.motion?.feetInLiquid) && active.by === 'brain' && active.kind === 'travel')
      return { wait: 'letting shore travel finish' };
    // An operator may start the permanent house before the brain adopts it as
    // its current job. Preserve the house concern's construction policy in
    // that handoff window instead of treating it as arbitrary outside work.
    const mine = memory.job ? concern(memory.job) : active.by === 'operator' && active.kind === 'house' ? house : null;
    const own = mine?.running?.(ctx);
    if (own) return own;
    // Brain-owned travel already feeds nearby hostiles into navigation's
    // deterministic evasion route. Cancelling that route on the same sighting
    // throws away its progress and launches a second flight in another
    // direction. A real hit still interrupts below.
    const navigating = ['walking', 'rough_route', 'no_rough_route', 'rerouting', 'travelling', 'evading'].includes(
      String(active.progress?.phase ?? ''),
    );
    if (active.by === 'brain' && danger && !hurt && mine?.id !== 'hide' && (active.kind === 'travel' || navigating))
      return { wait: `letting ${active.kind} navigation evade threat` };
    // A hostile that cannot be run from (a flight just failed here) does not cut work short either: the
    // alternative is a goal started and stopped every tick beside it. A hit still does.
    if ((hurt || (danger && !tried.has('hide'))) && !mine?.uncuttable) return { stop: hurt ? 'hurt' : 'threat' };
    if (classifyingHurt) return { wait: 'identifying damage source' };
    // Someone else's goal is otherwise left alone.
    if (active.by !== 'brain') return { wait: `letting ${active.kind} finish (${active.by})` };
    const cuts = concern(job).cuts;
    const pressing = job !== memory.job && !mine?.uncuttable && (typeof cuts === 'function' ? cuts(ctx) : !!cuts);
    if (pressing) return { stop: job };
    return { wait: `letting ${active.kind} finish` };
  }
  if (classifyingHurt) return { wait: 'identifying damage source' };
  const ready = readyDecision(ctx, concern);
  if (ready) return ready;
  let decision: Decision | undefined;
  if (dwelling && inside && sealed && job !== 'wait' && job !== 'go_home') {
    decision = workOn(job, ctx, concern);
    const indoors =
      ('start' in decision &&
        (['craft_item', 'light_shelter', 'eat', 'inspect_container', 'store_items', 'take_items'].includes(decision.start) ||
          (decision.start === 'build' && job === 'storage'))) ||
      'wait' in decision;
    if (!indoors && !('act' in decision)) {
      memory.job = 'leave_shelter';
      return workOn('leave_shelter', ctx, concern);
    }
  }
  if (job === 'wait' && s.atHome && !danger && !hurt && !storm) {
    for (const task of [knife, axe, shovel, hoe, bags, storage, torches, lighting, shelter, spareKnife]) {
      if (task.done?.(s) || tried.has(task.id) || (task.after ?? []).some(id => !concern(id).done?.(s))) continue;
      // A trial run: only indoor crafting counts, and whatever notes it drafted are dropped.
      const notes = memory.notes;
      const work = workOn(task.id, ctx, concern);
      memory.notes = notes;
      if ('start' in work && (work.start === 'craft_item' || work.start === 'light_shelter')) {
        memory.job = task.id;
        return work;
      }
    }
  }
  decision ??= workOn(job, ctx, concern);
  if ('start' in decision) memory.job = job;
  return decision;
}

// What to pick up in passing, whatever the current job: food where it grows, and the kit's shortfalls that lie on the ground.
export function wants(reading: Reading, memory?: Memory): string[] {
  const hunger = reading.state?.vitals?.hunger;
  if (memory?.notes.foodRecovery || (hunger?.max > 0 && hunger.current / hunger.max < 0.2)) return [];
  const k = kit(reading.inventory);
  return [...REFLEXES, ...TASKS].flatMap(concern => concern.wants?.(k) ?? []);
}
export function notes(memory: Memory): Notes {
  return { ...memory.notes, version: NOTES_VERSION };
}
export function fresh(kept?: Partial<Notes> | null): Memory {
  return {
    notes: parseNotes(kept),
    homeMarked: false,
    lastInventory: {},
    deathInventory: null,
    tried: {},
    situation: null,
    tried_now: [],
    marked: new Set(),
    job: null,
    pit: null,
    pitJob: null,
    burrow: null,
    startupChecked: false,
    startupAt: null,
    done: {},
    scares: [],
    lastThreat: null,
    resting: false,
    pendingHurtAt: null,
    dialogCloses: [],
    explainedUntil: 0,
    besiegedAt: null,
    tunnelTries: 0,
    stashMisses: 0,
    lightingFailed: false,
  };
}

const brain: Brain<Memory, Notes> = {
  name: 'default',
  description:
    'Early survival: forage and keep night provisions, knap tools, weave bags and storage, build and light a shelter, then an 8x5 rammed-earth home; maintain shared material supplies. Respawn, flee threats, and return before nightfall.',
  fresh,
  decide,
  wants,
  notes,
  summary: memory => ({
    home: memory.notes.home,
    stash: memory.notes.stash,
    stores: memory.notes.stores,
    house: memory.notes.house,
    farm: memory.notes.farm,
    construction: memory.notes.construction,
    lightingDay: memory.notes.lightingDay,
    firepit: memory.notes.firepit,
    burrow: memory.burrow,
    scares: memory.scares.length,
    job: memory.job,
    done: memory.done,
    tried: memory.tried,
    tasks: memory.situation ? tasks(memory.situation, new Set(memory.tried_now)) : [],
  }),
};
export default brain;
