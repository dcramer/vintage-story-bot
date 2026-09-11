import { randomUUID } from 'node:crypto';
import { Cause, Deferred, Effect, Fiber } from 'effect';
import { z } from 'zod';
import { actions } from './actions.mjs';
import { GameClient } from '../game/client.mjs';
import { Navigation } from '../navigation/navigator.mjs';
import { goalHandlers } from '../goals/registry.mjs';

const attempt = fn => Effect.tryPromise({ try: fn, catch: error => error instanceof Error ? error : new Error(String(error)) });

export class Controller {
  active = null; last = null; closing = false;
  session = randomUUID(); history = new Map();
  gate = Effect.runSync(Effect.makeSemaphore(1));
  constructor(send, telemetry = null) {
    this.game = new GameClient(send); this.telemetry = telemetry;
    if (telemetry) {
      const raw = this.game.send;
      this.game.send = (request, options) => raw(request, options).then(
        result => { this.trace(request, result); return result; },
        error => { this.trace(request, { ok: false, error: error.message }); throw error; });
    }
    this.send = this.game.send;
  }
  // Operator telemetry only: never awaited, never affects gameplay.
  trace(request, result) {
    const { action, ...args } = request;
    if (action === 'sense') { if (result.ok) this.telemetry.publish('state', result.state, { coalesce: true }); return; }
    if (action === 'observe') { if (result.ok) this.telemetry.publish('state', result, { coalesce: true }); return; }
    if (action === 'control_frame') { const { owner, ...frame } = args; this.telemetry.publish('frame', frame, { coalesce: true }); return; }
    if (action === 'scan' && result.ok) { this.telemetry.publish('scan', { match: args.match, kind: args.kind, radius: args.radius, objects: result.objects }, { coalesce: true }); return; }
    this.telemetry.publish('action', { action, args, ok: result.ok, error: result.error, code: result.code });
  }
  track(record, coalesce = false) { this.telemetry?.publish('goal', this.goalView(record), { coalesce }); }
  get map() { return this.game.map; }
  io(request) { return this.game.io(request); }
  view() { return this.last?.nav?.observe() ?? { state: 'idle' }; }
  info() { return { version: '0.1.0', session: this.session, active: !!this.active, terrainCells: this.map.cells.size }; }
  goalView(record = this.last) {
    if (!record) return null;
    return { id: record.id, kind: record.kind, state: record.kind === 'move_to' ? record.nav?.state ?? record.state : record.state,
      active: this.active === record, startedAt: record.startedAt, finishedAt: record.finishedAt,
      reason: record.reason ?? (record.kind === 'move_to' ? record.nav?.reason : undefined), progress: record.progress, result: record.result, cleanupError: record.cleanupError };
  }
  async stop(reason = 'stopped') {
    const active = this.active;
    if (!active) return;
    active.nav?.finish('cancelled', reason); active.state = 'cancelled'; active.reason = reason;
    this.track(active);
    await Effect.runPromise(Fiber.interrupt(active.fiber));
  }
  async close() { this.closing = true; await this.stop('controller_shutdown'); }
  request(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return Promise.reject(new Error('Expected an action object'));
    // Control-plane reads never wait for a game request or an in-flight goal startup.
    if (request.action === 'api' || request.action === 'goal_status') {
      const { action, ...args } = request;
      const parsed = actions.find(t => t.name === action).schema.parse(args);
      if (action === 'api') return Promise.resolve({ ok: true, controller: this.info(), actions: actions.map(t => ({
        name: t.name, action: t.action ?? t.name, execution: goalHandlers.has(t.name) ? 'goal' : t.readOnly ? 'query' : 'command',
        description: t.description, inputSchema: z.toJSONSchema(t.schema),
      })) });
      const goal = !parsed.id || parsed.id === this.last?.id ? this.goalView() : this.history.get(parsed.id);
      return Promise.resolve(goal === undefined
        ? { ok: false, code: 'goal_not_found', error: 'Goal unknown or evicted; controller may have restarted.', controller: this.info() }
        : { ok: true, controller: this.info(), goal });
    }
    if (request.action === 'stop') {
      const { action, ...args } = request;
      const { expectedGoal } = actions.find(t => t.name === 'stop').schema.parse(args);
      if (expectedGoal && this.last?.id !== expectedGoal) return Promise.resolve({ ok: false, error: 'Goal changed; no stop sent.' });
      const hadGoal = !!this.active;
      return this.stop().then(() => hadGoal ? { ok: true, status: 'stopped' } : this.send({ action: 'stop' }));
    }
    return Effect.runPromise(this.gate.withPermits(1)(attempt(async () => {
      if (this.closing) throw new Error('Controller shutting down');
      const tool = actions.find(t => (t.action ?? t.name) === request.action || t.name === request.action);
      if (!tool) throw new Error('Unknown controller action; screenshots/UI and raw control frames are not exposed.');
      const { action, ...args } = request;
      const parsed = tool.schema.parse(args);
      if (this.active && !tool.readOnly) throw new Error('Goal active; stop it before another mutation.');
      const handler = goalHandlers.get(tool.name);
      if (handler) return this.launch(tool.name, (record, started) => handler(this, parsed, record, started));
      const result = await this.send({ action: tool.action ?? tool.name, ...parsed });
      if (tool.name === 'observe' && result.ok) {
        result.navigation = this.view();
        result.goal = this.goalView();
        result.controller = this.info();
        if (!result.capabilities.includes('move_to')) result.capabilities.push('move_to');
      }
      return result;
    })));
  }
  launch(kind, work) {
    const started = Effect.runSync(Deferred.make());
    const record = { id: randomUUID(), kind, state: 'starting', startedAt: Date.now() };
    this.active = this.last = record;
    this.track(record);
    const program = Effect.scoped(work(record, started)).pipe(
      Effect.catchAllCause(cause => Effect.gen(function* () {
        const error = String(Cause.squash(cause));
        if (record.state !== 'cancelled') { record.nav?.finish('blocked', error); record.state = 'blocked'; record.reason = error; }
        this.track(record);
        yield* Deferred.succeed(started, { ok: false, error });
      })),
      Effect.ensuring(Effect.gen(this, function* () {
        yield* Deferred.succeed(started, { ok: false, error: record.reason ?? 'Goal cancelled before start' });
        if (this.active === record) this.active = null;
        record.finishedAt = Date.now();
        this.history.set(record.id, this.goalView(record));
        this.track(record);
        while (this.history.size > 64) this.history.delete(this.history.keys().next().value);
      })),
    );
    record.fiber = Effect.runFork(program);
    return Effect.runPromise(Deferred.await(started)).then(result => ({ ...result, goal: this.goalView(record), controller: this.info() }));
  }
  snapshot() { return this.game.snapshot(); }
  aim(angles, record) {
    const self = this;
    return Effect.scoped(Effect.gen(function* () {
      const initial = yield* self.io({ action: 'observe' });
      const control = yield* self.game.control(initial, error => { record.cleanupError = error.message; });
      for (let i = 0; i < 60; i++) {
        yield* control.frame({ ...angles, forward: false, jump: false });
        yield* Effect.sleep('50 millis');
        const state = yield* self.io({ action: 'observe' });
        if (state.control.owner !== control.owner) return yield* Effect.fail(new Error('Aiming interrupted'));
        const yawError = Math.abs(((angles.yawDegrees - state.orientation.yawDegrees + 540) % 360) - 180);
        if (yawError < 2 && Math.abs(angles.pitchDegrees - state.orientation.pitchDegrees) < 2) {
          yield* Effect.sleep('100 millis'); return;
        }
      }
      return yield* Effect.fail(new Error('Camera did not settle'));
    }));
  }
  navigate(goal, record, started, yieldWhen) {
    const self = this;
    return Effect.scoped(Effect.gen(function* () {
      const initial = yield* self.snapshot();
      if (goal.sprint && !initial.capabilities.includes('background_sprint'))
        return yield* Effect.fail(new Error('Update mod: background_sprint required'));
      if (!initial.controlReady || !initial.alive || !initial.motion.onGround || initial.motion.swimming || initial.motion.feetInLiquid || initial.mounted ||
        initial.life.alerts.some(a => a !== 'low_food') || initial.position.dimension !== 0 ||
        Math.abs(goal.x - initial.position.x) > 128 || Math.abs(goal.z - initial.position.z) > 128 || Math.abs(goal.y - initial.position.y) > 32)
        return yield* Effect.fail(new Error('Navigation needs grounded/dry/ready player and destination within 128 horizontal/32 vertical blocks.'));
      const control = yield* self.game.control(initial, error => { record.cleanupError = error.message; });
      const nav = record.nav = new Navigation(self.map, initial, goal);
      if (started) {
        nav.id = record.id; record.state = 'running';
        self.track(record);
        yield* Deferred.succeed(started, { ok: true, status: 'started', navigation: nav.observe() });
      }
      let state = initial;
      while (nav.active) {
        const batch = yield* self.game.sense();
        const reset = batch.terrain.reset;
        state = batch.state;
        if (state.player.uid !== initial.player.uid || state.life.session !== initial.life.session || state.control.owner !== control.owner ||
          !state.controlReady || !state.alive || state.life.lastDamageAt !== initial.life.lastDamageAt ||
          state.life.alerts.some(a => a !== 'low_food') || state.motion.swimming || state.motion.feetInLiquid || state.mounted || state.position.dimension !== 0) {
          nav.finish('cancelled', state.control.reason ?? 'identity_life_or_control_changed'); break;
        }
        if (reset) nav.survey(Date.now());
        const yielding = yieldWhen?.(state);
        // Yield only on supported ground; a food task must not take over mid-jump.
        if (yielding && state.motion.onGround && self.map.support(state.position, state.body.halfWidth) === 9) {
          nav.finish('yielded', yielding);
          break;
        }
        const frame = batch.terrain.more ? null : nav.tick(state);
        self.telemetry?.publish('navigation', nav.observe(), { coalesce: true });
        yield* control.frame({
          yawDegrees: frame?.yawDegrees ?? state.orientation.yawDegrees, pitchDegrees: frame?.pitchDegrees ?? 15,
          forward: frame?.forward ?? false, jump: frame?.jump ?? false, sprint: frame?.sprint ?? false, focus: frame?.focus ?? null });
        if (!nav.active) { yield* Effect.sleep('250 millis'); break; }
        yield* Effect.sleep(batch.terrain.more ? '5 millis' : '50 millis');
      }
      if (started) record.state = nav.state;
      self.telemetry?.publish('navigation', nav.observe(), { coalesce: true });
      return nav.observe();
    }));
  }
  runTask(policy, args, record, started) {
    const self = this;
    return Effect.gen(function* () {
      const cancellation = new AbortController();
      let running;
      yield* Effect.acquireRelease(Effect.succeed(cancellation), () => Effect.promise(async () => {
        cancellation.abort();
        // Wait for the Promise policy's own cleanup before another goal can acquire control.
        await running?.catch(() => {});
      }));
      record.state = 'running';
      self.track(record);
      yield* Deferred.succeed(started, { ok: true, status: 'started', goal: { id: record.id, kind: record.kind } });
      const send = request => {
        if (cancellation.signal.aborted && request.action !== 'stop') return Promise.reject(new Error('Goal cancelled'));
        return self.send(request);
      };
      const run = effect => Effect.runPromise(effect, { signal: cancellation.signal });
      running = policy({
        send, map: self.map, sync: () => run(self.snapshot()),
        aim: angles => run(self.aim(angles, record)), navigate: (goal, yieldWhen) => run(self.navigate(goal, record, undefined, yieldWhen)),
        report: progress => { record.progress = progress; self.track(record, true); },
      }, { ...args, signal: cancellation.signal });
      record.result = yield* attempt(() => running);
      record.state = record.result.ok ? 'arrived' : 'blocked';
    });
  }
}
