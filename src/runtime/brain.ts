// The core run loop of a bot with a brain installed. Every tick it reads what
// the player knows right now, hands that reading to the brain, and carries out
// the one decision it returns by starting or stopping a public goal through
// the controller, exactly as an adapter would. Any brain gets respawn for free.
// Goals started by someone else are never touched: the brain waits for them.
// The slice of the controller a brain loop uses; the class itself is plain JS.
export interface ControllerLike {
  active: any;
  last: any;
  brain: any;
  history: Map<string, any>;
  wants: string[];
  map?: any;
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
  last: { id: string; kind: string; ok: boolean; reason?: string; result?: any } | null;
  now: number;
};
// start: run a goal. act: call actions by hand, in order (a brain's own reflex, e.g. flee when no goal may walk).
export type Decision =
  | { start: string; args: Record<string, unknown>; why: string }
  | { act: Record<string, unknown>[]; why: string }
  | { stop: string }
  | { wait: string };
export interface Brain<Memory = unknown> {
  name: string;
  description: string;
  fresh(): Memory;
  decide(reading: Reading, memory: Memory): Decision;
  summary?(memory: Memory): Record<string, unknown>;
  // Code substrings worth picking up on the way, whatever goal runs.
  wants?(reading: Reading, memory: Memory): string[];
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>(resolve => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
const say = (text: string) => console.error(`${new Date().toISOString().slice(11, 19)} brain ${text}`);

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
  constructor(controller: ControllerLike, brain: Brain<Memory>, tickMs = 2000) {
    this.controller = controller;
    this.brain = brain;
    this.tickMs = tickMs;
    this.memory = brain.fresh();
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
          say(`fault: ${error instanceof Error ? error.message : String(error)}`);
        }
        await sleep(this.faults ? Math.min(30000, 2000 * this.faults) : this.tickMs, signal);
      }
    })();
  }
  // Uninstall: end the loop and cancel the brain's own goal; a goal someone
  // else started is left alone.
  async stop() {
    this.stopping.abort();
    await this.running;
    const active = this.controller.active as any;
    if (active && active.by === 'brain') await this.controller.stop('brain_removed');
  }
  private async tick() {
    this.ticks++;
    const controller = this.controller;
    const state = await controller.send({ action: 'observe' });
    if (!state.ok) throw new Error(state.error ?? 'observe refused');
    if (!state.alive) {
      if (!state.life?.deathId) return;
      say(`dead; respawning (${state.life.deathId})`);
      const respawn = await controller.send({ action: 'respawn', deathId: state.life.deathId });
      if (!respawn.ok) throw new Error(respawn.error ?? 'respawn refused');
      return;
    }
    // Deep water is the one thing no goal handles once a life alert is up: swim for the nearest dry ground.
    if (state.motion?.swimming && !controller.active) {
      await this.surface(state);
      return;
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
        result: view?.result,
      };
      this.goal = null;
    }
    // Someone else's goal: the brain keeps its hands off until it is over.
    if (active && active.by !== 'brain') {
      this.lastDecision = `waiting for ${active.kind} (${active.by})`;
      return;
    }
    const [inventory, environment] = await Promise.all([controller.send({ action: 'inventory' }), controller.send({ action: 'environment' })]);
    if (!inventory.ok) throw new Error(inventory.error ?? 'inventory refused');
    if (!environment.ok) throw new Error(environment.error ?? 'environment refused');
    const reading: Reading = { state, inventory, environment, active, last, now: Date.now() };
    if (this.brain.wants) controller.wants = this.brain.wants(reading, this.memory);
    const decision = this.brain.decide(reading, this.memory);
    if ('wait' in decision) {
      this.note(`wait: ${decision.wait}`);
      return;
    }
    if ('stop' in decision) {
      this.note(`stop: ${decision.stop}`);
      if (active) await controller.stop(`brain: ${decision.stop}`);
      return;
    }
    if (active) return;
    if ('act' in decision) {
      this.note(`act ${decision.act.map(a => a.action).join(', ')}: ${decision.why}`);
      for (const step of decision.act) {
        const done = await controller.request(step, { by: 'brain' });
        if (!done.ok) throw new Error(`${step.action} refused: ${done.error}`);
      }
      return;
    }
    this.note(`${decision.start} ${JSON.stringify(decision.args)}: ${decision.why}`);
    const started = await controller.request({ action: decision.start, ...decision.args }, { by: 'brain' });
    if (!started.ok) throw new Error(`${decision.start} refused: ${started.error}`);
    this.goal = { id: started.goal.id, kind: decision.start };
  }
  // Swim toward the nearest known dry ground with the jump key held (in water it keeps the head up),
  // one bounded stroke per tick; with no dry ground remembered, keep the current heading.
  private async surface(state: any) {
    const p = state.position;
    let yaw = state.orientation?.yawDegrees ?? 0,
      target: any = null;
    const map = this.controller.map;
    if (map) {
      let best = Infinity;
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
      if (target) yaw = ((Math.atan2(target.x - p.x, target.z - p.z) * 180) / Math.PI + 360) % 360;
    }
    this.note(
      `surfacing: swimming ${target ? `toward ${Math.round(target.x)},${Math.round(target.z)}` : 'ahead'}, oxygen ${Math.round(((state.vitals?.oxygen?.current ?? 0) / (state.vitals?.oxygen?.max || 1)) * 100)}%`,
    );
    await this.controller.send({ action: 'look', yawDegrees: yaw, pitchDegrees: 0 });
    await this.controller.send({ action: 'move', durationMs: 1500, direction: 'forward', jump: true, sprint: false, sneak: false });
  }
  private note(text: string) {
    if (text === this.lastDecision) return;
    this.lastDecision = text;
    say(text);
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
