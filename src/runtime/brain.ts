// The core run loop of a bot with a brain installed. Every tick it reads what
// the player knows right now, hands that reading to the brain, and carries out
// the one decision it returns by starting or stopping a public goal through
// the controller, exactly as an adapter would. Any brain gets respawn for free.
// Goals started by someone else are never touched: the brain waits for them.
// The slice of the controller a brain loop uses; the class itself is plain JS.
export interface ControllerLike {
  active: any; last: any; brain: any; history: Map<string, any>;
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
export type Decision =
  | { start: string; args: Record<string, unknown>; why: string }
  | { stop: string }
  | { wait: string };
export interface Brain<Memory = unknown> {
  name: string;
  description: string;
  fresh(): Memory;
  decide(reading: Reading, memory: Memory): Decision;
  summary?(memory: Memory): Record<string, unknown>;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});
const say = (text: string) => console.error(`${new Date().toISOString().slice(11, 19)} brain ${text}`);

export class BrainLoop<Memory> {
  memory: Memory;
  ticks = 0; faults = 0; lastDecision: string | null = null; startedAt = Date.now();
  goal: { id: string; kind: string } | null = null;
  private stopping = new AbortController();
  private running: Promise<void> | null = null;
  private controller: ControllerLike;
  brain: Brain<Memory>;
  private tickMs: number;
  constructor(controller: ControllerLike, brain: Brain<Memory>, tickMs = 2000) {
    this.controller = controller; this.brain = brain; this.tickMs = tickMs;
    this.memory = brain.fresh();
  }
  status() {
    return { name: this.brain.name, description: this.brain.description, startedAt: this.startedAt, ticks: this.ticks, faults: this.faults,
      lastDecision: this.lastDecision, goal: this.goal, ...(this.brain.summary?.(this.memory) ?? {}) };
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
    const record = controller.active as any;
    const active = record ? { id: record.id, kind: record.kind, state: record.state, by: record.by } : null;
    let last: Reading['last'] = null;
    if (this.goal && (!active || active.id !== this.goal.id)) {
      const view = controller.history.get(this.goal.id) ?? (controller.last?.id === this.goal.id ? controller.goalView() : null);
      last = { id: this.goal.id, kind: this.goal.kind, ok: view?.state === 'arrived', reason: view?.reason ?? view?.result?.reason, result: view?.result };
      this.goal = null;
    }
    // Someone else's goal: the brain keeps its hands off until it is over.
    if (active && active.by !== 'brain') { this.lastDecision = `waiting for ${active.kind} (${active.by})`; return; }
    const [inventory, environment] = await Promise.all([controller.send({ action: 'inventory' }), controller.send({ action: 'environment' })]);
    if (!inventory.ok) throw new Error(inventory.error ?? 'inventory refused');
    if (!environment.ok) throw new Error(environment.error ?? 'environment refused');
    const decision = this.brain.decide({ state, inventory, environment, active, last, now: Date.now() }, this.memory);
    if ('wait' in decision) { this.note(`wait: ${decision.wait}`); return; }
    if ('stop' in decision) {
      this.note(`stop: ${decision.stop}`);
      if (active) await controller.stop(`brain: ${decision.stop}`);
      return;
    }
    if (active) return;
    this.note(`${decision.start} ${JSON.stringify(decision.args)}: ${decision.why}`);
    const started = await controller.request({ action: decision.start, ...decision.args }, { by: 'brain' });
    if (!started.ok) throw new Error(`${decision.start} refused: ${started.error}`);
    this.goal = { id: started.goal.id, kind: decision.start };
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
  if (controller.brain) { await (controller.brain as BrainLoop<unknown>).stop(); controller.brain = null; }
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
