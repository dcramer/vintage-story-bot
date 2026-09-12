import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { findTool, goals, tools } from './registry.mjs';
import { compileGoalScript, runGoalPlan } from './goal-script.mjs';
import { GameClient } from './game.mjs';
import { Navigation } from './navigation/navigator.mjs';
import { Knowledge } from './navigation/knowledge.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// A promise settled once, from wherever settles it first.
const defer = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  let settled = false;
  return { promise, resolve: value => { if (!settled) { settled = true; resolve(value); } } };
};
const message = error => error instanceof Error ? error.message : String(error);

// One bot: the shared game client, its memory, one active goal at a time, and
// the tool registry every adapter (MCP, CLI, brain) speaks to.
export class Controller {
  active = null; last = null; closing = false; brain = null;
  session = randomUUID(); history = new Map(); waypoints = new Map();
  lock = Promise.resolve();
  constructor(send, telemetry = null) {
    this.game = new GameClient(send); this.telemetry = telemetry;
    this.knowledge = this.game.knowledge = new Knowledge(process.env.VINTAGE_STORY_KNOWLEDGE_DIR ?? '.runtime/knowledge', this.game);
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
    const perception = () => {
      if (!result.ok) return;
      this.telemetry.publish('state', result.state, { coalesce: true });
      if (result.surface?.columns?.length) this.telemetry.publish('map', { columns: result.surface.columns }, { coalesce: true });
    };
    if (action === 'sense') { perception(); return; }
    if (action === 'observe') { if (result.ok) this.telemetry.publish('state', result, { coalesce: true }); return; }
    if (action === 'control_frame' || action === 'control_step') {
      const { owner, session, after, ...frame } = args;
      this.telemetry.publish('frame', frame, { coalesce: true });
      if (action === 'control_step') perception();
      return;
    }
    if (action === 'scan' && result.ok) { this.telemetry.publish('scan', { match: args.match, kind: args.kind, radius: args.radius, objects: result.objects }, { coalesce: true }); return; }
    this.telemetry.publish('action', { action, args, ok: result.ok, error: result.error, code: result.code });
  }
  track(record, coalesce = false) { this.telemetry?.publish('goal', this.goalView(record), { coalesce }); logGoal(record); }
  get map() { return this.game.map; }
  get surface() { return this.game.surface; }
  get sightings() { return this.game.sightings; }
  io(request, signal) { return this.game.io(request, signal); }
  view() { return this.last?.nav?.observe() ?? { state: 'idle' }; }
  info() {
    return { version: '0.1.0', session: this.session, active: !!this.active, terrainCells: this.map.cells.size,
      knowledge: this.knowledge.status(), brain: this.brain?.status() ?? null };
  }
  goalView(record = this.last) {
    if (!record) return null;
    return { id: record.id, kind: record.kind, args: record.args, state: record.kind === 'move_to' ? record.nav?.state ?? record.state : record.state,
      active: this.active === record, startedAt: record.startedAt, finishedAt: record.finishedAt,
      intent: record.intent, reason: record.reason ?? (record.kind === 'move_to' ? record.nav?.reason : undefined),
      progress: record.progress, result: record.result, cleanupError: record.cleanupError, by: record.by };
  }
  // Cancel the active goal and wait for its cleanup, so nothing else can hold
  // the inputs until every finalizer (control_end, stop) has run.
  async stop(reason = 'stopped') {
    const active = this.active;
    if (!active) return;
    active.nav?.finish('cancelled', reason); active.state = 'cancelled'; active.reason = reason;
    this.track(active);
    active.abort.abort();
    await active.done;
  }
  // The eye: read what the player sees at a steady cadence whether or not a
  // goal is walking, so memory and threats are never older than a glance.
  // Read-only; a lost bridge just backs off until it returns.
  eye(intervalMs = 250) {
    if (this.eyeTimer) return;
    const tick = async () => {
      if (this.closing) return;
      let delay = intervalMs;
      // A walking goal's control frames already carry the feed; extra reads
      // would only compete with them on the game thread.
      if (!this.active?.nav?.active) { try { await this.game.sense(); } catch { delay = 2000; } }
      try { this.knowledge.save(); } catch (error) { this.telemetry?.publish('action', { action: 'knowledge_save', ok: false, error: error.message }); }
      if (!this.closing) this.eyeTimer = setTimeout(tick, delay);
    };
    this.eyeTimer = setTimeout(tick, intervalMs);
  }
  async close() {
    this.closing = true; clearTimeout(this.eyeTimer);
    await this.brain?.stop().catch(() => {});
    await this.stop('controller_shutdown');
    try { this.knowledge.save(true); } catch { /* nothing to keep, or nowhere to keep it */ }
  }
  // One request at a time past the control-plane reads, so a goal cannot start
  // while another mutation is still being judged.
  withLock(work) {
    const run = this.lock.then(work, work);
    this.lock = run.then(() => {}, () => {});
    return run;
  }
  request(request, { by } = {}) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return Promise.reject(new Error('Expected an action object'));
    // Control-plane reads never wait for a game request or an in-flight goal startup.
    if (request.action === 'api' || request.action === 'goal_status') {
      const { action, ...args } = request;
      const parsed = findTool(action).schema.parse(args);
      if (action === 'api') return Promise.resolve({ ok: true, controller: this.info(), actions: tools.map(t => ({
        name: t.name, action: t.action ?? t.name, execution: goals.includes(t) ? 'goal' : t.readOnly ? 'query' : 'command',
        description: t.description, inputSchema: z.toJSONSchema(t.schema),
      })) });
      const goal = !parsed.id || parsed.id === this.last?.id ? this.goalView() : this.history.get(parsed.id);
      return Promise.resolve(goal === undefined
        ? { ok: false, code: 'goal_not_found', error: 'Goal unknown or evicted; controller may have restarted.', controller: this.info() }
        : { ok: true, controller: this.info(), goal });
    }
    if (request.action === 'stop') {
      const { action, ...args } = request;
      const { expectedGoal } = findTool('stop').schema.parse(args);
      if (expectedGoal && this.last?.id !== expectedGoal) return Promise.resolve({ ok: false, error: 'Goal changed; no stop sent.' });
      const hadGoal = !!this.active;
      return this.stop().then(() => hadGoal ? { ok: true, status: 'stopped' } : this.send({ action: 'stop' }));
    }
    return this.withLock(async () => {
      if (this.closing) throw new Error('Controller shutting down');
      const tool = findTool(request.action);
      if (!tool) throw new Error('Unknown controller action; screenshots/UI and raw control frames are not exposed.');
      const { action, ...args } = request;
      const parsed = tool.schema.parse(args);
      if (this.active && !tool.readOnly) throw new Error('Goal active; stop it before another mutation.');
      if (tool.launch) return this.launch(tool.name, parsed, (record, started, signal) => tool.launch(this, parsed, record, started, signal), by);
      if (tool.run) return this.launch(tool.name, parsed, (record, started, signal) => this.runTask(tool.run, parsed, record, started, signal), by);
      if (tool.local) return tool.local(this, parsed);
      const result = await this.send({ action: tool.action ?? tool.name, ...parsed });
      if (tool.name === 'observe' && result.ok) {
        result.navigation = this.view();
        result.goal = this.goalView();
        result.controller = this.info();
        if (!result.capabilities.includes('move_to')) result.capabilities.push('move_to');
      }
      return result;
    });
  }
  // Fire-and-forget status chat so other players on the server can follow what the bot is doing.
  announce(kind, args) {
    const message = describeGoal(kind, args);
    if (message) Promise.resolve().then(() => this.send({ action: 'chat', message })).catch(() => {});
  }
  // Start one goal: the record is active until its work and cleanup finish,
  // whatever the outcome. START resolves as soon as the work reports it.
  launch(kind, args, work, by = 'operator') {
    const started = defer(), abort = new AbortController();
    const record = { id: randomUUID(), kind, args, by, state: 'starting', startedAt: Date.now(), abort,
      ...(typeof args.intent === 'string' ? { intent: args.intent } : {}) };
    this.active = this.last = record;
    this.track(record);
    this.announce(kind, args);
    record.done = (async () => {
      try {
        await work(record, started, abort.signal);
      } catch (error) {
        const reason = message(error);
        if (record.state !== 'cancelled') { record.nav?.finish('blocked', reason); record.state = 'blocked'; record.reason = reason; }
        this.track(record);
        started.resolve({ ok: false, error: reason });
      } finally {
        started.resolve({ ok: false, error: record.reason ?? 'Goal cancelled before start' });
        if (this.active === record) this.active = null;
        record.finishedAt = Date.now();
        this.history.set(record.id, this.goalView(record));
        this.track(record);
        while (this.history.size > 64) this.history.delete(this.history.keys().next().value);
      }
    })();
    return started.promise.then(result => ({ ...result, goal: this.goalView(record), controller: this.info() }));
  }
  snapshot(signal) { return this.game.snapshot(signal); }
  async aim(angles, record, safety, signal) {
    const initial = await this.io({ action: 'observe' }, signal);
    const control = await this.game.control(initial, error => { record.cleanupError = error.message; }, safety, signal);
    try {
      for (let i = 0; i < 60; i++) {
        const batch = await control.step({ ...angles, forward: false, jump: false });
        const state = batch.state;
        if (state.control.owner !== control.owner) throw new Error('Aiming interrupted');
        const yawError = Math.abs(((angles.yawDegrees - state.orientation.yawDegrees + 540) % 360) - 180);
        if (yawError < 2 && Math.abs(angles.pitchDegrees - state.orientation.pitchDegrees) < 2) { await sleep(100); return; }
      }
      throw new Error('Camera did not settle');
    } finally {
      await control.release();
    }
  }
  async navigate(goal, record, started, pauseWhen, { allowStarvingRecovery = false } = {}, signal) {
    const initial = await this.snapshot(signal);
    if (goal.sprint && !initial.capabilities.includes('background_sprint')) throw new Error('Update mod: background_sprint required');
    const alertsSafe = state => state.life.alerts.every(alert => alert === 'low_food' || alert === 'low_health' && allowStarvingRecovery);
    if (!initial.controlReady || !initial.alive || !initial.motion.onGround && !initial.motion.feetInLiquid || initial.motion.swimming && !goal.swim || initial.mounted ||
      !alertsSafe(initial) || initial.position.dimension !== 0 ||
      Math.abs(goal.x - initial.position.x) > 128 || Math.abs(goal.z - initial.position.z) > 128 || Math.abs(goal.y - initial.position.y) > 32)
      throw new Error('Navigation needs grounded/dry/ready player and destination within 128 horizontal/32 vertical blocks.');
    if (signal?.aborted) throw new Error('Goal cancelled');
    const control = await this.game.control(initial, error => { record.cleanupError = error.message; }, { allowStarvingRecovery }, signal);
    this.map.swim = !!goal.swim;
    const nav = record.nav = new Navigation(this.map, initial, goal);
    try {
      if (started) {
        nav.id = record.id; record.state = 'running';
        this.track(record);
        started.resolve({ ok: true, status: 'started', navigation: nav.observe() });
      }
      let state = initial, terrainMore = false;
      while (nav.active) {
        const pausing = pauseWhen?.(state);
        // Pause only on supported ground; a food task must not take over mid-jump.
        if (pausing && state.motion.onGround && this.map.standingOn(state.position)) { nav.finish('paused', pausing); break; }
        const frame = terrainMore ? null : nav.tick(state);
        const input = {
          yawDegrees: frame?.yawDegrees ?? state.orientation.yawDegrees, pitchDegrees: frame?.pitchDegrees ?? 15,
          forward: frame?.forward ?? false, jump: frame?.jump ?? false, sprint: frame?.sprint ?? false,
          sneak: frame?.sneak ?? false, focus: frame?.focus ?? null, durationMs: frame?.durationMs ?? 500 };
        this.telemetry?.publish('navigation', nav.observe(), { coalesce: true });
        // A refused frame means the hold is gone (expired, revoked, manual
        // input): the walk is cancelled, never blocked terrain.
        let batch;
        try { batch = await control.step(input); }
        catch (error) { nav.finish('cancelled', 'control_lost: ' + message(error)); break; }
        state = batch.state;
        if (state.life.lastDamageAt !== initial.life.lastDamageAt) {
          // Hurt: noted for the goal and its brain; the walk itself goes on.
          initial.life.lastDamageAt = state.life.lastDamageAt;
          nav.events = [...(nav.events ?? []).slice(-7), { type: 'hurt', at: Date.now(), health: state.vitals?.health?.current ?? null }];
        }
        if (state.player.uid !== initial.player.uid || state.life.session !== initial.life.session || state.control.owner !== control.owner ||
          !state.controlReady || !state.alive || !alertsSafe(state) || state.motion.swimming && !goal.swim || state.mounted || state.position.dimension !== 0) {
          nav.finish('cancelled', state.control.reason ?? 'identity_life_or_control_changed'); break;
        }
        if (batch.terrain.reset) nav.survey(Date.now());
        terrainMore = batch.terrain.more;
        if (!nav.active) break;
        const nextPause = pauseWhen?.(state);
        if (nextPause && state.motion.onGround && this.map.standingOn(state.position)) { nav.finish('paused', nextPause); break; }
        // Renew immediately after the sensed step, before deterministic route
        // planning on the next iteration. Repeating the already-vetted frame for
        // one game tick keeps planning time outside the heartbeat critical path.
        try {
          await control.frame(batch.terrain.reset ? {
            yawDegrees: state.orientation.yawDegrees, pitchDegrees: 15,
            forward: false, jump: false, sprint: false, sneak: false, focus: null,
          } : input);
        } catch (error) { nav.finish('cancelled', 'control_lost: ' + message(error)); break; }
      }
    } finally {
      await control.release();
    }
    if (started) record.state = nav.state;
    this.telemetry?.publish('navigation', nav.observe(), { coalesce: true });
    return nav.observe();
  }
  // A goal written as plain async code over a small environment. Cancellation
  // aborts the signal; the policy's own cleanup runs before the goal is over.
  async runTask(policy, args, record, started, signal) {
    record.state = 'running';
    this.track(record);
    started.resolve({ ok: true, status: 'started', goal: { id: record.id, kind: record.kind } });
    const send = request => {
      if (signal.aborted && request.action !== 'stop') return Promise.reject(new Error('Goal cancelled'));
      return this.send(request);
    };
    const env = {
      send, map: this.map, surface: this.surface, sightings: this.sightings, watch: list => this.game.attend(list),
      sync: () => this.snapshot(signal),
      aim: (angles, safety) => this.aim(angles, record, safety, signal),
      navigate: (goal, pauseWhen, safety) => this.navigate(goal, record, undefined, pauseWhen, safety, signal),
      report: progress => { record.progress = progress; this.track(record, true); },
    };
    record.result = await policy(env, { ...args, signal });
    record.state = record.result.ok ? 'arrived' : 'blocked';
  }
  runGoalScript(args, record, started, signal) {
    return this.runTask(async (env, { goalScript, signal }) => {
      const plan = compileGoalScript(goalScript, goals);
      const results = await runGoalPlan(plan, async (step, report) => {
        const stepEnv = { ...env, report };
        const stepArgs = { ...step.args, signal };
        return step.goal.compose ? step.goal.compose(this, stepEnv, stepArgs, record) : step.goal.run(stepEnv, stepArgs);
      }, env.report);
      return { ok: true, goal: 'goal_script', intent: args.intent, steps: results };
    }, args, record, started, signal);
  }
}

// One readable line per change of phase, target or state, so a goal's behavior can be followed from
// the controller's log (stderr: stdout is protocol-only under MCP).
const brief = value => value == null ? '' : typeof value === 'object'
  ? 'x' in value && 'z' in value ? `${Math.round(value.x)},${value.y == null ? '' : `${Math.round(value.y)},`}${Math.round(value.z)}`
    : Object.entries(value).filter(([, v]) => v != null && typeof v !== 'object').map(([k, v]) => `${k}=${v}`).join(' ')
  : String(value);
function logGoal(record) {
  const p = record.progress ?? {};
  const fields = Object.entries(p).filter(([key, value]) => key !== 'phase' && value != null && !(typeof value === 'object' && !('x' in value)))
    .map(([key, value]) => `${key}=${brief(value)}`).join(' ');
  const line = `${record.kind}#${record.id.slice(0, 4)} ${record.state}${p.phase ? ` ${p.phase}` : ''}${fields ? ` ${fields}` : ''}` +
    `${record.reason ? ` reason=${record.reason}` : ''}${record.result && record.state !== 'running' ? ` result=${brief(record.result)}` : ''}`;
  if (line === record.logged) return;
  record.logged = line;
  console.error(`${new Date().toISOString().slice(11, 19)} ${line}`);
}

// Short, human-sounding description of a starting goal for server chat.
export function describeGoal(kind, args = {}) {
  return findTool(kind)?.announce?.(args) ?? `Starting to ${String(kind).replace(/[-_]/g, ' ')}.`;
}
