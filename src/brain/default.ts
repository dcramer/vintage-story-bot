// Early survival decisions over current readings and durable camp notes.
// Concerns own their behavior; this file orders and interrupts them.

import type { Brain, Decision, Reading } from '../runtime/brain.ts';
import { horizontal } from '../runtime/navigation/terrain.ts';
import { temporalStormUnsafe } from '../support/fieldwork.ts';
import { hunger } from '../support/food.ts';
import { surfaceCover } from '../support/sites.ts';
import { copper } from './default/alongside/copper.ts';
import { homeMarker } from './default/alongside/home.ts';
import { suppliesMarker } from './default/alongside/supplies.ts';
import {
  type Alongside,
  allStashes,
  type Concern,
  type Context,
  cell,
  failedOnItsOwn,
  insideHome,
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
import { eat, hungry } from './default/reflexes/eat.ts';
import { explore } from './default/reflexes/explore.ts';
import { goHome } from './default/reflexes/go_home.ts';
import { hide } from './default/reflexes/hide.ts';
import { dangerHere, forgetOldScares, relocate } from './default/reflexes/relocate.ts';
import { shift } from './default/reflexes/shift.ts';
import { surfacing } from './default/reflexes/swim.ts';
import { SIEGE_MS, tunnel } from './default/reflexes/tunnel.ts';
import { unburrow } from './default/reflexes/unburrow.ts';
import { wait } from './default/reflexes/wait.ts';
import { isNight, kit, type Situation, senseDanger } from './default/situation.ts';
import { bags } from './default/tasks/bags.ts';
import { dirt } from './default/tasks/dirt.ts';
import { grass } from './default/tasks/grass.ts';
import { house } from './default/tasks/house.ts';
import { lighting, shelterLight } from './default/tasks/lighting.ts';
import { logs } from './default/tasks/logs.ts';
import { provisions } from './default/tasks/provisions.ts';
import { recover, recoverableBody } from './default/tasks/recover.ts';
import { homeDamage, repairHome } from './default/tasks/repair_home.ts';
import { resupply, resupplyOf } from './default/tasks/resupply.ts';
import { shelter } from './default/tasks/shelter.ts';
import { spareKnife } from './default/tasks/spare_knife.ts';
import { FULL_SLOTS, stash, surplusOf } from './default/tasks/stash.ts';
import { sticks } from './default/tasks/sticks.ts';
import { STOCK_CHECK_MS, stockpile, suppliesMissing } from './default/tasks/stockpile.ts';
import { storage } from './default/tasks/storage.ts';
import { axe, knife, shovel } from './default/tasks/tools.ts';
import { torches } from './default/tasks/torches.ts';

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
  provisions,
  shovel,
  dirt,
  grass,
  torches,
  shelter,
  lighting,
  sticks,
  spareKnife,
  logs,
  house,
  stockpile,
];
const leaveShelter: Concern = {
  id: 'leave_shelter',
  uncuttable: true,
  run: ({ memory, reading }) => {
    const door = memory.notes.dwelling!.door;
    const cells = [door, { ...door, y: door.y + 1 }];
    const outside = { ...door, z: door.z + 1 };
    if (surfaceCover(reading.terrain?.get(outside.x, outside.y, outside.z))) cells.push(outside);
    return { start: 'dig_area', args: { cells, timeoutMs: 120000 }, why: 'opening the shelter to leave' };
  },
};
const REFLEXES: Concern[] = [leaveShelter, hide, eat, goHome, burrow, unburrow, tunnel, shift, wait, relocate, digOut, explore];
// What runs beside any job, through tools that only talk.
const ALONGSIDE: Alongside[] = [copper, homeMarker, suppliesMarker];
// The ladder: danger, then hunger, then a storm, a bad place, night, then the
// list. A sealed burrow is already the safest response to something prowling
// outside: opening it to flee turns cover into a trap, and only actual damage
// proves the shelter unsafe. Hungry and dug in with nothing carried, it must
// dig out to look. A hostile that cannot be run from (across water, on a
// ledge) is not run from again at once; a dig-in that failed here is not
// tried again at once either, nor is opening a burrow that would not open.
export const LADDER: Rung[] = [
  { job: 'wait', when: s => !!s.sheltered && s.threat && !s.hurt && !hungry(s) },
  { job: 'unburrow', when: s => s.burrowed && s.hurt },
  { job: 'tunnel', when: (s, tried) => s.burrowed && s.threat && !s.hurt && s.besieged && !tried.has('tunnel') },
  // Rock stopped every tunnel: open the mouth and run (the hide rung takes over once outside), but not
  // onto a hostile at the mouth unless starvation leaves no choice.
  { job: 'unburrow', when: (s, tried) => s.burrowed && s.threat && !s.hurt && s.besieged && tried.has('tunnel') && (!s.threatNear || starving(s)) },
  { job: 'wait', when: s => s.burrowed && s.threat && !s.hurt },
  { job: 'hide', when: (s, tried) => s.hurt || (s.threat && !tried.has('hide')) },
  { job: 'unburrow', when: s => hungry(s) && s.burrowed && s.reserve <= 0 },
  { job: 'eat', when: s => hungry(s) || !!s.foodRecovery },
  { job: 'repair_home', when: (s, tried) => s.atHome && !!s.homeDamaged && !tried.has('repair_home') },
  { job: 'lighting', when: s => s.atHome && s.lit === false && s.torches > 0 },
  { job: 'go_home', when: (s, tried) => s.storm && s.home && !s.atHome && !tried.has('go_home') },
  { job: 'wait', when: s => s.storm && ((s.home && s.atHome) || s.burrowed) },
  { job: 'shift', when: (s, tried) => s.storm && !(s.home && s.atHome) && !s.burrowed && tried.has('burrow') },
  { job: 'burrow', when: s => s.storm },
  { job: 'relocate', when: s => s.dangerHere && !s.burrowed },
  { job: 'go_home', when: (s, tried) => s.night && s.home && !s.atHome && !tried.has('go_home') },
  { job: 'wait', when: s => s.night && ((s.home && s.atHome) || s.burrowed) },
  // A burrow that failed here (rock, nothing to seal it): walk on and dig in elsewhere, never stand in the dark.
  { job: 'shift', when: (s, tried) => s.night && !(s.home && s.atHome) && !s.burrowed && tried.has('burrow') },
  { job: 'burrow', when: s => s.night },
  { job: 'unburrow', when: (s, tried) => s.burrowed && !tried.has('unburrow') },
];
const CONCERNS = new Map<Job, Concern>([...REFLEXES, ...TASKS].map(concern => [concern.id, concern]));
const concern = (job: Job) => CONCERNS.get(job)!;

export const tasks = (s: Situation, tried: Set<Job> = new Set()) => taskList(TASKS, s, tried);
// A dialog left open by a goal that failed (a recipe selector, the handbook, a container) blocks every control;
// a player presses Escape. Character creation, death and disconnection are not closed this way.
// Escape is pressed at most a few times in a short while, then the wait says what is open.
export const DIALOG_CLOSES = 3;
// A hostile this close to the mouth makes opening it death.
export const THREAT_NEAR = 6;
// Below this satiety a burrow is opened whatever stands outside.
export const STARVING = 0.1;
const starving = (s: Situation) => s.hunger !== null && s.hunger < STARVING;
// How long damage the job explained keeps explaining after the job ended.
export const EXPLAINED_MS = 15000;
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
  // Damage the job just done explains (poison from a desperate bite) is known before the job is forgotten,
  // and for a while after: the poison outlasts the bite.
  if (memory.job && concern(memory.job).explains?.(events)) memory.explainedUntil = now + EXPLAINED_MS;
  if (last) {
    if (last.ok) memory.done[last.kind] = (memory.done[last.kind] ?? 0) + 1;
    const mine = memory.job ? concern(memory.job) : null;
    // A walk that ended in a hole is not a failed job: the hole is dealt with first. The hole is
    // where the body stands, whether or not the goal's result says so (travel does, others do not).
    if (last.reason === 'pit') {
      const where = last.result?.position ?? state.position;
      const toward = last.result?.toward;
      memory.pit = { x: toward?.x ?? where.x + 8, y: where.y, z: toward?.z ?? where.z };
    } else if (!last.ok && mine && (mine.setAside ?? failedOnItsOwn)(last, memory, reading))
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
    memory.startupAt = null;
    memory.pendingHurtAt = null;
    if (active) return { stop: 'dead' };
    if (temporalStormUnsafe(state)) return { wait: 'dead, waiting out temporal storm' };
    return state.life?.deathId && state.life?.canRespawn
      ? { act: [{ action: 'respawn', deathId: state.life.deathId }], why: 'dead' }
      : { wait: 'dead, waiting for respawn' };
  }
  // Death during multiplayer join can arrive before the client's Alive flag
  // and dialog synchronize. Do not perform ghost actions or invent a respawn
  // request; wait for the native life state to agree with the empty health bar.
  if (state.vitals?.health?.current === 0)
    return active ? { stop: 'zero health; waiting for life state to synchronize' } : { wait: 'zero health; waiting for life state to synchronize' };
  // A world still loading, a menu or a dialog: no goal can begin, and one refused
  // before it began would only be started again at once. Wait for the controls.
  if (state.controlReady === false) {
    // A running goal's own dialog (a container open for a transfer, a recipe selector) is its to close.
    const closable = active ? null : closableDialog(reading.dialogs);
    memory.dialogCloses = memory.dialogCloses.filter(at => now - at < DIALOG_CLOSE_MS);
    if (closable && memory.dialogCloses.length < DIALOG_CLOSES) {
      memory.dialogCloses.push(now);
      return { act: [{ action: 'close_dialog' }], why: `${closable} blocks the controls` };
    }
    return { wait: 'controls not ready (loading, menu or dialog)' };
  }
  const startup = recoverBurrow(reading, memory);
  if (startup) return startup;
  const { danger, hurt, classifyingHurt } = senseDanger(reading, memory, now < memory.explainedUntil);
  let satiety: number | null = null;
  try {
    satiety = hunger(state);
  } catch {
    satiety = null;
  }
  const storm = temporalStormUnsafe(state);
  const k = kit(inventory);
  if (satiety !== null && satiety < 0.2) memory.notes.foodRecovery = true;
  else if (satiety !== null && satiety >= 0.5) delete memory.notes.foodRecovery;
  const home = memory.notes.home;
  const tried = triedNow(memory, state.position, now);
  const dwelling = memory.notes.dwelling;
  const houseOrigin = memory.notes.house;
  const starter = memory.notes.starter;
  const light = shelterLight(reading, memory.notes);
  const inside = insideHome(memory.notes, state.position);
  const sealed =
    !!dwelling &&
    [0, 1].every(dy => {
      const block = reading.terrain?.get(dwelling.door.x, dwelling.door.y + dy, dwelling.door.z);
      return !!block && !block.hazard && block.boxes.length > 0;
    });
  const damaged = inside && homeDamage(reading, memory.notes).length > 0;
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
    stone: k.stone,
    torches: k.torches + light.installed,
    grass: k.grass,
    dirt: k.dirt,
    buildingMaterials: k.buildingMaterials,
    rammedShelter: !!starter || !!houseOrigin,
    logs: k.logs,
    storage: !!memory.notes.stash,
    bags: k.bags,
    full: k.free <= FULL_SLOTS,
    surplus: surplusOf(k, { home: !!home, torches: k.torches, building: !!memory.notes.construction || !!memory.notes.shelter }).reduce(
      (n, i) => n + i.count,
      0,
    ),
    short: resupplyOf(k, { home: !!home, torches: k.torches }, memory.notes.stash).reduce((n, i) => n + i.count, 0),
    moreStorage:
      allStashes(memory.notes).length < 3 &&
      allStashes(memory.notes).length > 0 &&
      allStashes(memory.notes).every(stash => stash.full) &&
      suppliesMissing(allStashes(memory.notes)).length > 0,
    house: !!memory.notes.house,
    lit: light.lit,
    stocked:
      allStashes(memory.notes).length > 0 &&
      allStashes(memory.notes).every(stash => stash.seen && now - stash.seen.at < STOCK_CHECK_MS) &&
      suppliesMissing(allStashes(memory.notes)).length === 0,
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
    for (const alongside of ALONGSIDE) {
      const decision = alongside.act(ctx);
      if (decision) return decision;
    }
  // A goal of its own is running. What cuts it short is what the ladder would rather do now:
  // danger first, then a storm, night, a bad place, or food in hand when hungry.
  if (active) {
    const mine = memory.job ? concern(memory.job) : null;
    const own = mine?.running?.(ctx);
    if (own) return own;
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
  let decision: Decision | undefined;
  if (dwelling && inside && sealed && job !== 'wait' && job !== 'go_home') {
    decision = concern(job).run(ctx);
    const indoors =
      ('start' in decision &&
        (['craft_item', 'light_shelter', 'eat'].includes(decision.start) ||
          (decision.start === 'build' && (job === 'repair_home' || job === 'storage')))) ||
      (job === 'repair_home' && 'wait' in decision);
    if (!indoors && !('act' in decision)) {
      memory.job = 'leave_shelter';
      return leaveShelter.run(ctx);
    }
  }
  if (job === 'wait' && s.atHome && !danger && !hurt && !storm) {
    for (const task of [knife, axe, shovel, torches, lighting, spareKnife]) {
      if (task.done?.(s) || tried.has(task.id) || (task.after ?? []).some(id => !concern(id).done?.(s))) continue;
      const work = task.run(ctx);
      if ('start' in work && (work.start === 'craft_item' || work.start === 'light_shelter')) {
        memory.job = task.id;
        return work;
      }
    }
  }
  decision ??= concern(job).run(ctx);
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
    notes: {
      ...(typeof kept?.recovery?.guid === 'string' && Number.isFinite(kept?.recovery?.until)
        ? { recovery: { guid: kept.recovery.guid, until: kept.recovery.until } }
        : {}),
      home: cell(kept?.home),
      ...(cell(kept?.shelter) ? { shelter: cell(kept?.shelter) } : {}),
      ...(cell(kept?.starter) ? { starter: cell(kept?.starter) } : {}),
      ...(Number.isFinite(kept?.lightingDay) ? { lightingDay: kept!.lightingDay } : {}),
      ...(cell(kept?.firepit) ? { firepit: cell(kept?.firepit) } : {}),
      ...(kept?.failedFirepits?.length ? { failedFirepits: kept.failedFirepits.filter(p => cell(p) && Number.isFinite(p.until)).slice(-16) } : {}),
      ...(Number.isInteger(kept?.cooking?.count) && kept!.cooking!.count > 0 && kept!.cooking!.count <= 4
        ? { cooking: { count: kept!.cooking!.count, ...(kept?.cooking?.needsFuel === true ? { needsFuel: true } : {}) } }
        : {}),
      ...(Number.isFinite(kept?.cookUntil) ? { cookUntil: kept!.cookUntil } : {}),
      ...(kept?.foodRecovery === true ? { foodRecovery: true } : {}),
      ...(cell(kept?.house) ? { house: cell(kept?.house) } : {}),
      ...(cell(kept?.construction?.origin) && ['walls', 'floor', 'enter'].includes(kept?.construction?.phase ?? '')
        ? { construction: { origin: cell(kept!.construction!.origin)!, phase: kept!.construction!.phase } }
        : {}),
      stash: stashNote(kept?.stash),
      ...(Array.isArray(kept?.stores)
        ? {
            stores: kept.stores
              .map(stashNote)
              .filter((s): s is NonNullable<typeof s> => !!s)
              .slice(0, 2),
          }
        : {}),
      dwelling:
        cell(kept?.dwelling?.door) && typeof kept?.dwelling?.item === 'string' ? { door: cell(kept.dwelling.door)!, item: kept.dwelling.item } : null,
    },
    homeMarked: false,
    tried: {},
    situation: null,
    tried_now: [],
    marked: new Set(),
    job: null,
    pit: null,
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
    construction: memory.notes.construction,
    lightingDay: memory.notes.lightingDay,
    firepit: memory.notes.firepit,
    cooking: memory.notes.cooking,
    burrow: memory.burrow,
    scares: memory.scares.length,
    job: memory.job,
    done: memory.done,
    tried: memory.tried,
    tasks: memory.situation ? tasks(memory.situation, new Set(memory.tried_now)) : [],
  }),
};
export default brain;
