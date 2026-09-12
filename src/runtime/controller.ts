import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Places } from '../support/places.ts';
import { EventLog } from './events.ts';
import { GameClient } from './game.ts';
import { compileGoalScript, runGoalPlan } from './goal-script.ts';
import { type Log, noLog } from './log.ts';
import { Knowledge } from './navigation/knowledge.ts';
import { Navigation } from './navigation/navigator.ts';
import { findTool, goals, tools } from './registry.ts';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// A promise settled once, from wherever settles it first.
const defer = () => {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  let settled = false;
  return {
    promise,
    resolve: value => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    },
  };
};
const message = error => (error instanceof Error ? error.message : String(error));
// Reads that run in loops: logged only when refused.
const polling = new Set([
  'sense',
  'observe',
  'inventory',
  'environment',
  'messages',
  'events',
  'target',
  'dialogs',
  'recipes',
  'scan',
  'map_waypoints',
]);
const looping = new Set(['control_frame', 'control_step', 'block_action_status', 'block_action_continue']);
// Server chat: a goal announces itself once it has run this long, and never repeats the line it just said.
const ANNOUNCE_GRACE_MS = 2000,
  ANNOUNCE_REPEAT_MS = 10 * 60 * 1000;

// One bot: the shared game client, its memory, one active goal at a time, and
// the tool registry every adapter (MCP, CLI, brain) speaks to.
export class Controller {
  eyeTimer: any;
  lifeLogged: string | undefined;
  game: any;
  knowledge: any;
  send: any;
  telemetry: any;
  log: Log;
  active = null;
  last = null;
  closing = false;
  brain = null;
  wants = [];
  // Walked and failed 16x16 areas, shared by every goal of the session.
  places = new Places();
  // The last full look around, so a goal that replaces another does not sweep the same spot again.
  looks: { last: any } = { last: null };
  session = randomUUID();
  history = new Map();
  waypoints = new Map();
  lock = Promise.resolve();
  events = new EventLog();
  chatCursor = { after: 0, session: undefined as string | undefined };
  announced: { message: string; at: number } | null = null;
  constructor(send, telemetry = null, log: Log = noLog) {
    this.game = new GameClient(send);
    this.game.events = this.events;
    this.log = log;
    this.events.subscribe(event => {
      this.telemetry?.publish('event', event);
      const { id, at, type, ...data } = event;
      // A first sighting is frequent and mostly routine: kept in the file, off the mirror.
      this.log[type === 'sighted' ? 'debug' : 'info']('event', type, { event: id, ...data });
    });
    this.telemetry = telemetry;
    this.knowledge = this.game.knowledge = new Knowledge(process.env.VINTAGE_STORY_KNOWLEDGE_DIR ?? '.runtime/knowledge', this.game);
    const raw = this.game.send;
    this.game.send = (request, options) => {
      const since = performance.now();
      return raw(request, options).then(
        result => {
          this.trace(request, result, since);
          return result;
        },
        error => {
          this.trace(request, { ok: false, error: error.message }, since);
          throw error;
        },
      );
    };
    this.send = this.game.send;
  }
  // What went to the mod and what came back: the session log keeps every request
  // but the ones that run in loops, which it keeps only when refused; operator
  // telemetry gets the live topics. Never awaited, never affects gameplay.
  trace(request, result, since = performance.now()) {
    const { action, ...args } = request;
    const ms = Math.round(performance.now() - since);
    if (!result.ok)
      this.log.info('mod', 'refused', { action, args: looping.has(action) ? undefined : args, error: result.error, code: result.code, ms });
    else if (!polling.has(action) && !looping.has(action)) this.log.debug('mod', action, { args, ms });
    if (!this.telemetry) return;
    const perception = () => {
      if (!result.ok) return;
      this.telemetry.publish('state', result.state, { coalesce: true });
      if (result.surface?.columns?.length) this.telemetry.publish('map', { columns: result.surface.columns }, { coalesce: true });
    };
    if (action === 'sense') {
      perception();
      return;
    }
    if (action === 'observe') {
      if (result.ok) this.telemetry.publish('state', result, { coalesce: true });
      return;
    }
    if (action === 'control_frame' || action === 'control_step') {
      const { owner, session, after, ...frame } = args;
      this.telemetry.publish('frame', frame, { coalesce: true });
      if (action === 'control_step') perception();
      return;
    }
    if (action === 'scan' && result.ok) {
      this.telemetry.publish('scan', { match: args.match, kind: args.kind, radius: args.radius, objects: result.objects }, { coalesce: true });
      return;
    }
    this.telemetry.publish('action', { action, args, ok: result.ok, error: result.error, code: result.code });
  }
  // A goal's state for the operator and the session log: every state change at info,
  // every progress report at debug.
  track(record, coalesce = false) {
    this.telemetry?.publish('goal', this.goalView(record), { coalesce });
    if (coalesce) record.log?.debug('goal', 'progress', record.progress ?? {});
    else if (record.state !== record.logged) {
      record.logged = record.state;
      const done = record.finishedAt != null;
      record.log?.info('goal', record.state, {
        ...(record.state === 'starting' ? { by: record.by, args: record.args } : {}),
        ...(record.progress?.phase ? { phase: record.progress.phase } : {}),
        reason: record.reason,
        ...(done ? { result: record.result, ms: record.finishedAt - record.startedAt } : {}),
      });
    }
  }
  get map() {
    return this.game.map;
  }
  get surface() {
    return this.game.surface;
  }
  get sightings() {
    return this.game.sightings;
  }
  io(request: object, signal?: AbortSignal) {
    return this.game.io(request, signal);
  }
  view() {
    return this.last?.nav?.observe() ?? { state: 'idle' };
  }
  info() {
    return {
      version: '0.1.0',
      session: this.session,
      active: !!this.active,
      terrainCells: this.map.cells.size,
      knowledge: this.knowledge.status(),
      brain: this.brain?.status() ?? null,
    };
  }
  goalView(record = this.last) {
    if (!record) return null;
    return {
      id: record.id,
      kind: record.kind,
      args: record.args,
      state: record.kind === 'move_to' ? (record.nav?.state ?? record.state) : record.state,
      active: this.active === record,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      intent: record.intent,
      reason: record.reason ?? (record.kind === 'move_to' ? record.nav?.reason : undefined),
      progress: record.progress,
      result: record.result,
      cleanupError: record.cleanupError,
      by: record.by,
    };
  }
  // Cancel the active goal and wait for its cleanup, so nothing else can hold
  // the inputs until every finalizer (control_end, stop) has run.
  async stop(reason = 'stopped'): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.nav?.finish('cancelled', reason);
    active.state = 'cancelled';
    active.reason = reason;
    this.track(active);
    active.abort.abort();
    await active.done;
  }
  // The eye: read what the player sees at a steady cadence whether or not a
  // goal is walking, so memory and threats are never older than a glance.
  // Read-only; a lost bridge just backs off until it returns.
  eyeTicks = 0;
  eye(intervalMs = 250) {
    if (this.eyeTimer) return;
    const tick = async () => {
      if (this.closing) return;
      let delay = intervalMs;
      // A walking goal's control frames already carry the feed; extra reads
      // would only compete with them on the game thread.
      if (!this.active?.nav?.active) {
        try {
          const batch = await this.game.sense();
          if (this.eyeTicks % 4 === 0) this.sample(batch.state);
        } catch (error) {
          delay = 2000;
          this.log.debug('eye', 'lost', { error: message(error) });
        }
      }
      // Chat lines the player has read since the last look, once a second.
      if (++this.eyeTicks % 4 === 0 && this.game.capabilities.includes('chat_messages')) {
        try {
          const batch = await this.game.send({ action: 'messages', ...this.chatCursor });
          if (batch.ok) {
            this.chatCursor = { after: batch.cursor, session: batch.session };
            for (const line of batch.messages ?? [])
              this.events.emit('message', { sender: line.sender ?? null, text: line.text, kind: line.type, group: line.group });
          }
        } catch {
          /* the next tick reads again */
        }
      }
      try {
        this.knowledge.save();
      } catch (error) {
        this.telemetry?.publish('action', { action: 'knowledge_save', ok: false, error: error.message });
        this.log.info('controller', 'knowledge_save_failed', { error: error.message });
      }
      if (!this.closing) this.eyeTimer = setTimeout(tick, delay);
    };
    this.eyeTimer = setTimeout(tick, intervalMs);
  }
  // Own state once a second, so a session can be replayed as a trajectory: where the
  // body was, what it looked at and how it was doing. A new life session is noted.
  sample(state) {
    if (!state?.ok) return;
    const p = state.position ?? {};
    if (state.life?.session !== this.lifeLogged) {
      this.lifeLogged = state.life?.session;
      this.log.info('eye', 'life', { life: state.life?.session, player: state.player?.uid, world: state.world?.identifier, dimension: p.dimension });
    }
    const tenth = v => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);
    this.log.debug('eye', 'sample', {
      position: { x: tenth(p.x), y: tenth(p.y), z: tenth(p.z) },
      yaw: Math.round(state.orientation?.yawDegrees ?? 0),
      health: state.vitals?.health?.current,
      hunger: state.vitals?.hunger?.current,
      oxygen: state.vitals?.oxygen?.current,
      alive: state.alive,
      controlReady: state.controlReady,
      swimming: state.motion?.swimming || undefined,
      storm: state.condition?.temporalStorm?.phase,
      entities: state.nearbyEntities?.length || undefined,
    });
  }
  async close() {
    this.closing = true;
    clearTimeout(this.eyeTimer);
    await this.brain?.stop().catch(() => {});
    await this.stop('controller_shutdown');
    try {
      this.knowledge.save(true);
    } catch {
      /* nothing to keep, or nowhere to keep it */
    }
  }
  // One request at a time past the control-plane reads, so a goal cannot start
  // while another mutation is still being judged.
  withLock(work) {
    const run = this.lock.then(work, work);
    this.lock = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  request(request, { by }: { by?: string } = {}) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return Promise.reject(new Error('Expected an action object'));
    // Control-plane reads never wait for a game request or an in-flight goal startup.
    if (request.action === 'api' || request.action === 'goal_status' || request.action === 'events') {
      const { action, ...args } = request;
      const parsed = findTool(action).schema.parse(args);
      if (action === 'events') return findTool('events').local(this, parsed);
      if (action === 'api')
        return Promise.resolve({
          ok: true,
          controller: this.info(),
          actions: tools.map(t => ({
            name: t.name,
            action: t.action ?? t.name,
            execution: goals.includes(t) ? 'goal' : t.readOnly ? 'query' : 'command',
            concurrent: !!t.concurrent,
            description: t.description,
            inputSchema: z.toJSONSchema(t.schema),
          })),
        });
      const goal = !parsed.id || parsed.id === this.last?.id ? this.goalView() : this.history.get(parsed.id);
      return Promise.resolve(
        goal === undefined
          ? { ok: false, code: 'goal_not_found', error: 'Goal unknown or evicted; controller may have restarted.', controller: this.info() }
          : { ok: true, controller: this.info(), goal },
      );
    }
    if (request.action === 'stop') {
      const { action, ...args } = request;
      const { expectedGoal } = findTool('stop').schema.parse(args);
      if (expectedGoal && this.last?.id !== expectedGoal) return Promise.resolve({ ok: false, error: 'Goal changed; no stop sent.' });
      const hadGoal = !!this.active;
      return this.stop().then(() => (hadGoal ? { ok: true, status: 'stopped' } : this.send({ action: 'stop' })));
    }
    return this.withLock(async () => {
      if (this.closing) throw new Error('Controller shutting down');
      const tool = findTool(request.action);
      if (!tool) throw new Error('Unknown controller action; screenshots/UI and raw control frames are not exposed.');
      const { action, ...args } = request;
      const parsed = tool.schema.parse(args);
      // A tool that needs the body waits for the goal; one that only talks (chat, map markers, memory) runs alongside it.
      if (this.active && !tool.readOnly && !tool.concurrent) throw new Error('Goal active; stop it before another mutation.');
      if (!polling.has(action)) this.log.debug('tool', action, { by, args: parsed });
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
    }).catch(error => {
      this.log.info('tool', 'refused', { action: request.action, by, error: message(error) });
      throw error;
    });
  }
  // Fire-and-forget status chat so other players on the server can follow what the bot is doing.
  // A line is said once: a goal restarted with the same story (a retry, a follow-up recovery) stays quiet
  // until a different line has been said or the last one has gone stale.
  announce(kind, args) {
    const message = describeGoal(kind, args),
      now = Date.now();
    if (!message) return;
    if (this.announced?.message === message && now - this.announced.at < ANNOUNCE_REPEAT_MS) return;
    this.announced = { message, at: now };
    Promise.resolve()
      .then(() => this.send({ action: 'chat', message }))
      .catch(() => {});
  }
  // Start one goal: the record is active until its work and cleanup finish,
  // whatever the outcome. START resolves as soon as the work reports it.
  launch(kind, args, work, by = 'operator') {
    const started = defer(),
      abort = new AbortController();
    const record: any = {
      id: randomUUID(),
      kind,
      args,
      by,
      state: 'starting',
      startedAt: Date.now(),
      abort,
      ...(typeof args.intent === 'string' ? { intent: args.intent } : {}),
    };
    record.log = this.log.bind({ goal: record.id, kind });
    this.active = this.last = record;
    this.track(record);
    this.events.emit('goal_started', { goal: record.id, kind, by });
    // Announced only once the goal has actually got going: a step that ends within the grace is not worth a chat line.
    const announce = setTimeout(() => {
      if (this.active === record && record.state !== 'cancelled') this.announce(kind, args);
    }, ANNOUNCE_GRACE_MS);
    record.done = (async () => {
      try {
        await work(record, started, abort.signal);
      } catch (error) {
        const reason = message(error);
        if (record.state !== 'cancelled') {
          record.nav?.finish('blocked', reason);
          record.state = 'blocked';
          record.reason = reason;
        }
        this.track(record);
        started.resolve({ ok: false, error: reason });
      } finally {
        clearTimeout(announce);
        started.resolve({ ok: false, error: record.reason ?? 'Goal cancelled before start' });
        if (this.active === record) this.active = null;
        record.finishedAt = Date.now();
        this.history.set(record.id, this.goalView(record));
        this.events.emit('goal_finished', {
          goal: record.id,
          kind,
          by,
          state: record.state,
          ok: record.state === 'arrived',
          reason: record.reason ?? record.result?.reason ?? null,
        });
        this.track(record);
        while (this.history.size > 64) this.history.delete(this.history.keys().next().value);
      }
    })();
    return started.promise.then((result: any) => ({ ...result, goal: this.goalView(record), controller: this.info() }));
  }
  snapshot(signal) {
    return this.game.snapshot(signal);
  }
  async aim(angles, record, safety?, signal?: AbortSignal) {
    const initial = await this.io({ action: 'observe' }, signal);
    const control = await this.game.control(
      initial,
      error => {
        record.cleanupError = error.message;
      },
      safety,
      signal,
    );
    try {
      // The mod takes a pitch of at most 89 degrees; straight down at the feet is 89.
      angles = { ...angles, pitchDegrees: Math.max(-89, Math.min(89, angles.pitchDegrees ?? 0)) };
      for (let i = 0; i < 60; i++) {
        const batch = await control.step({ ...angles, forward: false, jump: false });
        const state = batch.state;
        if (state.control.owner !== control.owner) throw new Error('Aiming interrupted');
        const yawError = Math.abs(((angles.yawDegrees - state.orientation.yawDegrees + 540) % 360) - 180);
        if (yawError < 2 && Math.abs(angles.pitchDegrees - state.orientation.pitchDegrees) < 2) {
          await sleep(100);
          return;
        }
      }
      throw new Error('Camera did not settle');
    } finally {
      await control.release();
    }
  }
  async navigate(goal, record, started?, pauseWhen?, { allowStarvingRecovery = false } = {}, signal?: AbortSignal) {
    const initial = await this.snapshot(signal);
    if (goal.sprint && !initial.capabilities.includes('background_sprint')) throw new Error('Update mod: background_sprint required');
    if (
      !initial.controlReady ||
      !initial.alive ||
      (!initial.motion.onGround && !initial.motion.feetInLiquid) ||
      (initial.motion.swimming && goal.swim === false) ||
      initial.mounted ||
      initial.position.dimension !== 0 ||
      Math.abs(goal.x - initial.position.x) > 128 ||
      Math.abs(goal.z - initial.position.z) > 128 ||
      Math.abs(goal.y - initial.position.y) > 32
    )
      throw new Error('Navigation needs grounded/dry/ready player and destination within 128 horizontal/32 vertical blocks.');
    if (signal?.aborted) throw new Error('Goal cancelled');
    const control = await this.game.control(
      initial,
      error => {
        record.cleanupError = error.message;
      },
      { allowStarvingRecovery },
      signal,
    );
    this.map.swim = goal.swim !== false;
    const nav = (record.nav = new Navigation(this.map, initial, goal));
    let state = initial;
    try {
      if (started) {
        nav.id = record.id;
        record.state = 'running';
        this.track(record);
        started.resolve({ ok: true, status: 'started', navigation: nav.observe() });
      }
      let terrainMore = false,
        route = nav.route;
      let input: any = null,
        stepView: any = null,
        pagingSince = Date.now();
      while (nav.active) {
        const pausing = pauseWhen?.(state);
        // Pause only on supported ground; a food task must not take over mid-jump.
        if (pausing && state.motion.onGround && this.map.standingOn(state.position)) {
          nav.finish('paused', pausing);
          break;
        }
        // While terrain pages are still streaming the map is half updated, so the route is not
        // re-checked; the last vetted frame carries on for up to a second, then the body waits.
        // The commanded yaw is always the follower's own: echoing the observed yaw back, which
        // lags the camera by a frame, rocks the head from side to side.
        const frame = terrainMore ? null : nav.tick(state, Date.now(), stepView);
        const carryOn = terrainMore && !!input?.forward && !input.jump && Date.now() - pagingSince < 1000;
        if (!terrainMore) pagingSince = Date.now();
        input = {
          yawDegrees: frame?.yawDegrees ?? input?.yawDegrees ?? state.orientation.yawDegrees,
          pitchDegrees: frame?.pitchDegrees ?? 15,
          forward: frame?.forward ?? carryOn,
          jump: frame?.jump ?? false,
          sprint: frame?.sprint ?? (carryOn && input.sprint),
          sneak: frame?.sneak ?? false,
          focus: frame?.focus ?? null,
          durationMs: frame?.durationMs ?? 250,
          ...(frame?.toward || (carryOn && input?.toward)
            ? {
                toward: frame?.toward ?? input.toward,
                reach: frame?.reach ?? input.reach,
                reachY: frame?.reachY ?? input.reachY,
                hop: frame?.hop ?? input.hop,
                next: frame?.next ?? input?.next,
              }
            : {}),
        };
        this.telemetry?.publish('navigation', nav.observe(), { coalesce: true });
        if (nav.route !== route) {
          route = nav.route;
          record.log?.info('nav', 'route', {
            replan: nav.replans,
            why: nav.lastReplan,
            from: state.position,
            to: route.at(-1),
            checkpoints: route.length,
            route: route.map(n => `${n.x.toFixed(1)},${n.y},${n.z.toFixed(1)}${n.move && n.move !== 'walk' ? `(${n.move})` : ''}`),
          });
        }
        record.log?.debug('nav', 'frame', {
          position: state.position,
          yaw: Math.round(state.orientation.yawDegrees),
          want: nav.desiredYaw == null ? undefined : Math.round(nav.desiredYaw),
          to: Math.round(input.yawDegrees),
          forward: input.forward,
          jump: input.jump,
          sprint: input.sprint,
          ms: input.durationMs,
          toward: input.toward ? `${input.toward.x.toFixed(1)},${input.toward.y},${input.toward.z.toFixed(1)}${input.hop ? '(hop)' : ''}` : undefined,
          step: stepView ? `${stepView.state}@${stepView.distance}` : undefined,
          checkpoint: `${nav.index}/${nav.route?.length ?? 0}`,
          paging: terrainMore || undefined,
        });
        // A refused frame means the hold is gone (expired, revoked, manual
        // input): the walk is cancelled, never blocked terrain.
        let batch;
        try {
          batch = await control.step(input);
        } catch (error) {
          nav.finish('cancelled', 'control_lost: ' + message(error));
          break;
        }
        state = batch.state;
        stepView = batch.step ?? null;
        if (state.life.lastDamageAt !== initial.life.lastDamageAt) {
          // Hurt: noted for the goal and its brain; the walk itself goes on.
          initial.life.lastDamageAt = state.life.lastDamageAt;
          nav.events = [...(nav.events ?? []).slice(-7), { type: 'hurt', at: Date.now(), health: state.vitals?.health?.current ?? null }];
        }
        if (
          state.player.uid !== initial.player.uid ||
          state.life.session !== initial.life.session ||
          state.control.owner !== control.owner ||
          !state.controlReady ||
          !state.alive ||
          (state.motion.swimming && goal.swim === false) ||
          state.mounted ||
          state.position.dimension !== 0
        ) {
          nav.finish('cancelled', state.control.reason ?? 'identity_life_or_control_changed');
          break;
        }
        if (batch.terrain.reset) nav.survey(Date.now());
        terrainMore = batch.terrain.more;
        if (!nav.active) break;
        const nextPause = pauseWhen?.(state);
        if (nextPause && state.motion.onGround && this.map.standingOn(state.position)) {
          nav.finish('paused', nextPause);
          break;
        }
        // Renew immediately after the sensed step, before deterministic route
        // planning on the next iteration. Repeating the already-vetted frame for
        // one game tick keeps planning time outside the heartbeat critical path.
        try {
          const renewed = await control.frame(
            batch.terrain.reset
              ? {
                  yawDegrees: input.yawDegrees,
                  pitchDegrees: 15,
                  forward: false,
                  jump: false,
                  sprint: false,
                  sneak: false,
                  focus: null,
                }
              : input,
          );
          if (renewed?.step) stepView = renewed.step;
          // A step in flight is watched about ten times a second, not as fast as the loopback allows.
          if (input.toward && stepView?.state === 'walking') await sleep(60);
        } catch (error) {
          nav.finish('cancelled', 'control_lost: ' + message(error));
          break;
        }
      }
    } finally {
      await control.release();
    }
    if (started) record.state = nav.state;
    this.telemetry?.publish('navigation', nav.observe(), { coalesce: true });
    record.log?.info('nav', nav.state, {
      reason: nav.reason,
      target: nav.target,
      position: state.position,
      replans: nav.replans,
      remaining: Math.max(0, nav.route.length - nav.index),
      ms: Date.now() - record.startedAt,
      ...(nav.diagnostics ? { diagnostics: nav.diagnostics } : {}),
    });
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
      send,
      map: this.map,
      surface: this.surface,
      sightings: this.sightings,
      watch: list => this.game.attend(list),
      wants: this.wants,
      places: this.places,
      looks: this.looks,
      sync: () => this.snapshot(signal),
      aim: (angles, safety) => this.aim(angles, record, safety, signal),
      navigate: (goal, pauseWhen, safety) => this.navigate(goal, record, undefined, pauseWhen, safety, signal),
      log: record.log,
      report: progress => {
        record.progress = progress;
        this.track(record, true);
      },
    };
    record.result = await policy(env, { ...args, signal });
    record.state = record.result.ok ? 'arrived' : 'blocked';
  }
  runGoalScript(args, record, started, signal) {
    return this.runTask(
      async (env, { goalScript, signal }) => {
        const plan = compileGoalScript(goalScript, goals);
        const results = await runGoalPlan(
          plan,
          async (step, report) => {
            const stepEnv = { ...env, report };
            const stepArgs = { ...step.args, signal };
            return step.goal.compose ? step.goal.compose(this, stepEnv, stepArgs, record) : step.goal.run(stepEnv, stepArgs);
          },
          env.report,
        );
        return { ok: true, goal: 'goal_script', intent: args.intent, steps: results };
      },
      args,
      record,
      started,
      signal,
    );
  }
}

// Short, human-sounding description of a starting goal for server chat.
export function describeGoal(kind, args = {}) {
  return findTool(kind)?.announce?.(args) ?? `Starting to ${String(kind).replace(/[-_]/g, ' ')}.`;
}
