// The default brain's parts. A concern is one thing the bot cares about: a
// reflex (hide, eat, go home), a task on the day-1 list (sticks, tools, a
// shelter) or the idle job. Each owns its predicate, the goal it starts, its
// say while that goal runs, and the bookkeeping when it ends; the brain file
// only orders them. The ladder (which reflex now) and the task list are data,
// re-derived from the Situation every tick: nothing is queued.
import type { Decision, Reading } from '../../runtime/brain.ts';
import { horizontal } from '../../runtime/navigation/terrain.ts';
import type { Kit, Situation } from './situation.ts';

export type Cell = { x: number; y: number; z: number };
export type Job =
  | 'hide'
  | 'go_home'
  | 'wait'
  | 'eat'
  | 'dirt'
  | 'shelter'
  | 'sticks'
  | 'knife'
  | 'axe'
  | 'shovel'
  | 'spare_knife'
  | 'grass'
  | 'torches'
  | 'logs'
  | 'explore'
  | 'dig_out'
  | 'burrow'
  | 'unburrow'
  | 'tunnel'
  | 'relocate'
  | 'recover'
  | 'storage'
  | 'bags'
  | 'stash'
  | 'resupply';
// The container the bot keeps things in: its observed key (cell and block code), and what it
// held when last closed. Unknown until opened; stale once anyone else has been at it.
export type Stash = {
  key: string;
  x: number;
  y: number;
  z: number;
  code: string;
  seen: { at: number; items: Record<string, number> } | null;
};
// What is kept between runs: the decisions made about this world, and what the bot itself last
// left in its own chest (re-verified when it is opened); what the eye saw of the world is Knowledge.
export type Notes = {
  home: Cell | null;
  stash: Stash | null;
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
  pit: Cell | null;
  // The pocket the bot dug in for the night: its mouth cell, to dig open again at dawn.
  burrow: Cell | null;
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
  // When the brain last pressed Escape on a dialog that blocked the controls.
  dialogCloses: number[];
  // Until when a hit is explained by the job just done (poison after a bite).
  explainedUntil: number;
  // Since when something has prowled outside the sealed burrow, and tunnel bearings tried since.
  besiegedAt: number | null;
  tunnelTries: number;
  // Times in a row the chest could not be aimed at where its note says.
  stashMisses: number;
  // Sighting keys already marked on the map, so one nugget is announced once.
  marked: Set<string>;
};
export type Ended = NonNullable<Reading['last']>;
// One tick's reading, digested: what every concern decides on.
export type Context = {
  reading: Reading;
  state: any;
  events: any[];
  markers: Reading['markers'];
  active: Reading['active'];
  now: number;
  memory: Memory;
  s: Situation;
  k: Kit;
  tried: Set<Job>;
  danger: { point: Cell; code: string } | null;
  hurt: boolean;
  classifyingHurt: boolean;
  satiety: number | null;
  storm: boolean;
  home: Cell | null;
  // What the ladder picked this tick.
  job: Job;
};
export type Concern = {
  id: Job;
  // On the task list: what the task is for, in the bot's words.
  title?: string;
  // A task: done when the kit or the notes show it, re-checked every tick; `after` names what it waits on.
  done?: (s: Situation) => boolean;
  after?: Job[];
  // A reflex the ladder turns to cuts a lesser running job short (a function: only sometimes).
  cuts?: boolean | ((ctx: Context) => boolean);
  // Its goal is never cut short, not by danger and not by a pressing job.
  uncuttable?: boolean;
  // The goal (or wait) that works on it.
  run: (ctx: Context) => Decision;
  // Its own say while its goal runs, before the generic rules; null to let them decide.
  running?: (ctx: Context) => Decision | null;
  // Bookkeeping when its goal ended, whatever the outcome.
  ended?: (last: Ended, memory: Memory, reading: Reading) => void;
  // Whether a failed goal sets the job aside around here; default: it failed for a reason of its own.
  setAside?: (last: Ended, memory: Memory, reading: Reading) => boolean;
  // Set aside wherever the bot is, not only near where it failed.
  setAsideEverywhere?: boolean;
  // Damage its running goal explains (poison from a desperate bite), so a hit is not an attack.
  explains?: (events: any[]) => boolean;
  // Code substrings worth picking up on the way while this concern has a shortfall.
  wants?: (k: Kit) => string[];
  // What the kit is short of for this task, as an item code substring and a count; storage may hold it.
  short?: (k: Kit, s: Pick<Situation, 'home' | 'torches'>) => { item: string; count: number } | null;
};
// Something done alongside any job through tools that only talk: a marker, a chat line.
export type Alongside = { id: string; act: (ctx: Context) => Decision | null };
// One rung of the ladder: the reflex to turn to when its condition holds, in order of concern.
export type Rung = { job: Job; when: (s: Situation, tried: Set<Job>) => boolean };

// A job that failed is left alone while the bot is still near where it failed, and for a few
// minutes at most; the ladder goes on to the next job meanwhile, so nothing ever idles on it.
export const TRIED_RADIUS = 24;
export const TRIED_MS = 5 * 60 * 1000;
// A job the surroundings refused before it began (water, lost controls) or that the brain
// itself cut short is not the job's fault; any other failure sets it aside. The controller
// names the outcome; the pattern is only for a reading that has none.
export const failedOnItsOwn = (last: Ended) =>
  last.outcome
    ? last.outcome !== 'refused' && last.outcome !== 'interrupted'
    : !/interruption|^brain:|^Start grounded$|^Navigation needs/.test(last.reason ?? '');

export type TaskState = 'done' | 'next' | 'open' | 'set aside' | 'waiting';
// The list as the brain sees it now: what is done, what is next, what waits.
export function tasks(list: Concern[], s: Situation, tried: Set<Job> = new Set()): { id: Job; title: string; state: TaskState }[] {
  let next: Job | null = null;
  const finished = new Set(list.filter(task => task.done?.(s)).map(task => task.id));
  return list.map(task => {
    let state: TaskState = task.done?.(s)
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
    return { id: task.id, title: task.title ?? task.id, state };
  });
}
// The whole character in one choice: the first rung whose condition holds, else the first
// task not done, not waiting and not set aside around here, else the idle job.
export function pickJob(ladder: Rung[], list: Concern[], idle: Job, s: Situation, tried: Set<Job> = new Set()): Job {
  return ladder.find(rung => rung.when(s, tried))?.job ?? tasks(list, s, tried).find(task => task.state === 'next')?.id ?? idle;
}

export const cell = (c: any): Cell | null => (c && [c.x, c.y, c.z].every(Number.isFinite) ? { x: c.x, y: c.y, z: c.z } : null);
export const stashNote = (n: any): Stash | null =>
  n && typeof n.key === 'string' && typeof n.code === 'string' && cell(n)
    ? {
        key: n.key,
        ...cell(n)!,
        code: n.code,
        seen:
          n.seen && Number.isFinite(n.seen.at) && n.seen.items && typeof n.seen.items === 'object'
            ? { at: n.seen.at, items: { ...n.seen.items } }
            : null,
      }
    : null;
// A task with a place goes there first: a walk when the place is farther than the goal itself would go, else null.
export function goTo(ctx: Context, place: { x: number; z: number }, why: string, radius = 12, arrival = 3): Decision | null {
  const far = horizontal(place, ctx.state.position);
  if (far <= radius) return null;
  return {
    start: 'travel',
    args: { x: place.x, z: place.z, arrivalRadius: arrival, manageFood: true, timeoutMs: 900000 },
    why: `${why}, ${Math.round(far)} blocks away`,
  };
}
// The goal stood where the note says and found no chest to open there: not the same as a walk that
// never got there. Twice in a row and the note is dropped, and a new chest is made.
export const containerMissing = (last: Ended) => /changed or obstructed|No container dialog/i.test(last.reason ?? '');
export const STASH_MISSES = 2;
// What the container held when the goal closed it, remembered until the next look.
export function noteContents(memory: Memory, last: Ended, now: number) {
  if (!memory.notes.stash) return;
  if (containerMissing(last)) {
    if (++memory.stashMisses >= STASH_MISSES) {
      memory.notes.stash = null;
      memory.stashMisses = 0;
    }
    return;
  }
  if (last.ok) memory.stashMisses = 0;
  const contents = last.result?.contents;
  if (!Array.isArray(contents)) return;
  const items: Record<string, number> = {};
  for (const stack of contents) if (typeof stack?.code === 'string') items[stack.code] = (items[stack.code] ?? 0) + (stack.quantity ?? 0);
  memory.notes.stash.seen = { at: now, items };
}
// Home is a note: it outlives the process, and moving house is rewriting it.
export function setHome(memory: Memory, home: Cell | null) {
  memory.notes.home = cell(home);
  memory.homeMarked = false;
}
