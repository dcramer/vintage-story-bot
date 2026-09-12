// The core run loop of a bot with a brain installed. Every tick, and as soon
// as the controller notices something, it reads what the player knows right
// now, hands that reading to the brain, and carries out the one decision it
// returns by starting or stopping a goal or calling actions by hand, exactly
// as an adapter would. The loop decides nothing itself: respawning, swimming
// for shore, running from a hit are all the brain's to choose.
import { type Log, noLog } from './log.ts';
import { Notes } from './notes.ts';

// The slice of the controller a brain loop uses; the class itself is plain JS.
export interface ControllerLike {
  active: any;
  last: any;
  brain: any;
  log?: Log;
  history: Map<string, any>;
  wants: string[];
  map?: any;
  events?: any;
  knowledge?: { dir?: string };
  send(request: object): Promise<any>;
  request(request: object, options?: { by?: string }): Promise<any>;
  stop(reason?: string): Promise<void>;
  goalView(record?: any): any;
}

export type Reading = {
  state: any;
  inventory: any;
  environment: any;
  // The goal running now, whoever started it, or null when idle.
  active: { id: string; kind: string; state: string; by: string } | null;
  // The brain's own goal that finished since the previous tick, once.
  last: { id: string; kind: string; ok: boolean; reason?: string; outcome?: string; result?: any } | null;
  // What the controller noticed since the previous decision, oldest first (events).
  events: any[];
  // The player's own markers on the game map, when the mod reports them.
  markers: { guid: string; title: string; icon: string; position: { x: number; y: number; z: number } }[];
  // The nearest remembered dry standing cell within 16 blocks while swimming, else null.
  ground: { x: number; y: number; z: number } | null;
  // The native dialogs open while the controls are blocked (alive, controlReady false), else null.
  dialogs: { name: string; blocksControl: boolean }[] | null;
  // The terrain cells currently known to the controller. Brains may inspect
  // them but never mutate them.
  terrain: any;
  now: number;
};
// start: run a goal (only while none runs). act: call actions by hand, in order; alongside a
// goal only tools that talk (chat, map markers, memory) are allowed. stop: cancel the running
// goal, whoever started it. wait: nothing.
export type Decision =
  | { start: string; args: Record<string, unknown>; why: string }
  | { act: Record<string, unknown>[]; why: string }
  | { stop: string }
  | { wait: string };
export interface Brain<Memory = unknown, Durable = unknown> {
  name: string;
  description: string;
  // A memory to start from: fresh, or carrying the notes kept from an earlier run in this world.
  fresh(notes?: Durable | null): Memory;
  decide(reading: Reading, memory: Memory): Decision;
  summary?(memory: Memory): Record<string, unknown>;
  // The part of memory worth keeping between runs, as JSON: decisions about the
  // world (home, chests), never what was seen or what only matters this session.
  notes?(memory: Memory): Durable;
  // Code substrings worth picking up on the way, whatever goal runs.
  wants?(reading: Reading, memory: Memory): string[];
}

export class BrainLoop<Memory> {
  memory: Memory;
  ticks = 0;
  faults = 0;
  lastDecision: string | null = null;
  startedAt = Date.now();
  goal: { id: string; kind: string } | null = null;
  private stopping = new AbortController();
  private running: Promise<void> | null = null;
  private controller: ControllerLike;
  brain: Brain<Memory>;
  private tickMs: number;
  // Events are read from here on; the loop wakes early when one lands.
  private cursor: number;
  private nudge: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private log: Log;
  notes: Notes;
  constructor(controller: ControllerLike, brain: Brain<Memory>, tickMs = 2000) {
    this.controller = controller;
    this.brain = brain;
    this.log = (controller.log ?? noLog).bind({ brain: brain.name });
    this.tickMs = tickMs;
    this.notes = new Notes(controller.knowledge?.dir ?? null, brain.name);
    this.memory = brain.fresh(null);
    this.cursor = controller.events?.sequence ?? 0;
    this.unsubscribe = controller.events?.subscribe?.(() => this.nudge?.()) ?? null;
  }
  status() {
    return {
      name: this.brain.name,
      description: this.brain.description,
      startedAt: this.startedAt,
      ticks: this.ticks,
      faults: this.faults,
      lastDecision: this.lastDecision,
      goal: this.goal,
      notes: this.brain.notes ? this.notes.status() : undefined,
      ...(this.brain.summary?.(this.memory) ?? {}),
    };
  }
  start() {
    if (this.running) return;
    const signal = this.stopping.signal;
    this.running = (async () => {
      while (!signal.aborted) {
        try {
          await this.tick();
          this.faults = 0;
        } catch (error) {
          // A loading world or a lost bridge drops reads for a while; keep trying.
          this.faults++;
          this.log.info('brain', 'fault', { faults: this.faults, error: error instanceof Error ? error.message : String(error) });
        }
        await this.rest(this.faults ? Math.min(30000, 2000 * this.faults) : this.tickMs, signal);
      }
    })();
  }
  // Sleep until the tick is due, an event lands, or the loop stops; a fault's back-off is not cut short.
  private rest(ms: number, signal: AbortSignal) {
    return new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        this.nudge = null;
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      if (!this.faults) this.nudge = () => setTimeout(done, 50);
      signal.addEventListener('abort', done, { once: true });
      if (!this.faults && (this.controller.events?.sequence ?? 0) > this.cursor) this.nudge?.();
    });
  }
  // Uninstall: end the loop and cancel the brain's own goal; a goal someone
  // else started is left alone.
  async stop() {
    this.stopping.abort();
    this.unsubscribe?.();
    await this.running;
    this.keep(true);
    const active = this.controller.active as any;
    if (active && active.by === 'brain') await this.controller.stop('brain_removed');
  }
  // The brain's notes to disk when they changed; a full disk never stops the loop.
  private keep(force = false) {
    if (!this.brain.notes) return;
    try {
      this.notes.set(this.brain.notes(this.memory));
      if (this.notes.save(force)) this.log.info('brain', 'notes_saved', { file: this.notes.status().file });
    } catch (error) {
      this.log.info('brain', 'notes_save_failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
  private async tick() {
    this.ticks++;
    const controller = this.controller;
    const state = await controller.send({ action: 'observe' });
    if (!state.ok) throw new Error(state.error ?? 'observe refused');
    // A world seen for the first time this run: memory starts from the notes kept about it.
    if (this.notes.enter(state.world?.identifier, state.player?.uid)) {
      this.memory = this.brain.fresh(this.notes.data as any);
      // A goal of the world just left ended with it; its bookkeeping has no memory to land in.
      this.goal = null;
      if (this.notes.loaded) this.log.info('brain', 'notes_loaded', { file: this.notes.status().file, ...this.notes.loaded });
    }
    const record = controller.active as any;
    const active = record ? { id: record.id, kind: record.kind, state: record.state, by: record.by } : null;
    let last: Reading['last'] = null;
    if (this.goal && (!active || active.id !== this.goal.id)) {
      const view = controller.history.get(this.goal.id) ?? (controller.last?.id === this.goal.id ? controller.goalView() : null);
      last = {
        id: this.goal.id,
        kind: this.goal.kind,
        ok: view?.state === 'arrived',
        reason: view?.reason ?? view?.result?.reason,
        outcome: view?.outcome,
        result: view?.result,
      };
      this.goal = null;
    }
    const [inventory, environment, markers, dialogs] = await Promise.all([
      controller.send({ action: 'inventory' }),
      controller.send({ action: 'environment' }),
      this.markers(state),
      this.dialogs(state),
    ]);
    if (!inventory.ok) throw new Error(inventory.error ?? 'inventory refused');
    if (!environment.ok) throw new Error(environment.error ?? 'environment refused');
    const batch = controller.events?.read?.(this.cursor, null, { limit: 128 }) ?? { events: [], cursor: this.cursor };
    this.cursor = batch.cursor;
    const reading: Reading = {
      state,
      inventory,
      environment,
      active,
      last,
      events: batch.events,
      markers,
      ground: state.motion?.swimming || state.motion?.feetInLiquid ? this.dryGround(state) : null,
      dialogs,
      terrain: controller.map ?? null,
      now: Date.now(),
    };
    if (this.brain.wants) controller.wants = this.brain.wants(reading, this.memory);
    const decision = this.brain.decide(reading, this.memory);
    this.keep();
    // What the brain saw when it decided: enough to read the decision back later.
    const saw = {
      tick: this.ticks,
      active: active ? `${active.kind}:${active.state}` : undefined,
      last: last ? { kind: last.kind, ok: last.ok, reason: last.reason } : undefined,
      events: batch.events.length ? batch.events.map(e => e.type) : undefined,
      health: state.vitals?.health?.current,
      hunger: state.vitals?.hunger?.current,
    };
    if ('wait' in decision) {
      this.note('wait', { why: decision.wait, ...saw }, this.lastDecision === `wait: ${decision.wait}` ? 'debug' : 'info');
      this.lastDecision = `wait: ${decision.wait}`;
      return;
    }
    if ('stop' in decision) {
      this.note('stop', { why: decision.stop, ...saw });
      this.lastDecision = `stop: ${decision.stop}`;
      if (active) await controller.stop(`brain: ${decision.stop}`);
      return;
    }
    if ('act' in decision) {
      this.note('act', { actions: decision.act.map(a => a.action), why: decision.why, ...saw });
      this.lastDecision = `act ${decision.act.map(a => a.action).join(', ')}: ${decision.why}`;
      for (const step of decision.act) {
        const done = await controller.request(step, { by: 'brain' });
        if (!done.ok) throw new Error(`${step.action} refused: ${done.error}`);
      }
      return;
    }
    if (active) {
      this.note('blocked', { start: decision.start, why: decision.why, ...saw }, 'debug');
      this.lastDecision = `cannot start ${decision.start} while ${active.kind} runs; stop it first`;
      return;
    }
    this.note('start', { start: decision.start, args: decision.args, why: decision.why, ...saw });
    this.lastDecision = `${decision.start} ${JSON.stringify(decision.args)}: ${decision.why}`;
    const started = await controller.request({ action: decision.start, ...decision.args }, { by: 'brain' });
    if (!started.ok) throw new Error(`${decision.start} refused: ${started.error}`);
    this.goal = { id: started.goal.id, kind: decision.start };
  }
  // The dialogs open while the controls are blocked, when the mod reports them; a refusal reads as unknown.
  private async dialogs(state: any) {
    if (state.controlReady !== false || !state.alive || !state.capabilities?.includes?.('ui_dialogs')) return null;
    const read = await this.controller.send({ action: 'ui_dialogs' }).catch(() => null);
    return read?.ok ? (read.dialogs ?? []).map(d => ({ name: d.name, blocksControl: !!d.blocksControl })) : null;
  }
  // The player's own map markers, when the mod reports them; a refusal reads as none.
  private async markers(state: any) {
    if (!state.capabilities?.includes?.('map_waypoints')) return [];
    const read = await this.controller.send({ action: 'map_waypoints' }).catch(() => null);
    return read?.ok ? (read.waypoints ?? []).map(w => ({ guid: w.guid, title: w.title, icon: w.icon, position: w.position })) : [];
  }
  // The nearest remembered dry standing cell within 16 blocks, from terrain memory.
  private dryGround(state: any) {
    const p = state.position,
      map = this.controller.map;
    if (!map) return null;
    let best = Infinity,
      target: any = null;
    for (let dx = -16; dx <= 16; dx++)
      for (let dz = -16; dz <= 16; dz++) {
        const node = map.nodeAt(Math.floor(p.x) + dx, Math.floor(p.z) + dz, p.y, 2, 4);
        if (!node || node.wet || node.swim) continue;
        const far = Math.hypot(node.x - p.x, node.z - p.z);
        if (far < best) {
          best = far;
          target = node;
        }
      }
    return target ? { x: target.x, y: target.y, z: target.z } : null;
  }
  // Every decision is logged; a wait repeated tick after tick drops to debug so
  // the mirror stays readable while the file keeps the full record.
  private note(decision: string, fields: Record<string, unknown>, level: 'info' | 'debug' = 'info') {
    this.log[level]('brain', decision, fields);
  }
}

const valid = /^[a-z][a-z0-9_-]{0,31}$/;
// Install a brain by name (a file in src/brain), or none. Replacing a brain
// stops the old loop first; the bot never runs two.
export async function installBrain(controller: ControllerLike, name: string | null) {
  if (controller.brain) {
    await (controller.brain as BrainLoop<unknown>).stop();
    controller.brain = null;
  }
  if (!name) return null;
  if (!valid.test(name)) throw new Error('Brain names are lowercase file names, e.g. default');
  const brain = (await import(`../brain/${name}.ts`)).default as Brain<unknown>;
  if (brain?.name !== name || typeof brain.decide !== 'function' || typeof brain.fresh !== 'function')
    throw new Error(`src/brain/${name}.ts must default-export a brain named ${name} with fresh and decide`);
  const loop = new BrainLoop(controller, brain);
  controller.brain = loop;
  loop.start();
  return loop;
}
