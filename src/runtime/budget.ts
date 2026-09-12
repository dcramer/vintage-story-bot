import { monitorEventLoopDelay } from 'node:perf_hooks';
import { type Log, noLog } from './log.ts';

// What each part of a real-time loop may take. A bot that answers the game late
// is a bot standing still with the keys held, so going over is news: one line
// per thing per ten seconds, with how often and how badly, never a flood.
export const budgets = {
  // Milliseconds for one round trip to the mod: the per-frame reads and steps, and everything else.
  requestFrame: 100,
  request: 250,
  // Milliseconds the mod's own work may take in one game tick, and the longest silence between ticks.
  modTick: 8,
  frameGap: 250,
  // Node's event loop: the delay a timer sees at the 99th percentile over five seconds, and a single stall.
  loopLag: 50,
  loopStall: 200,
  // One navigator decision, one walk-loop iteration, and the idle eye's cadence.
  planning: 50,
  walkIteration: 300,
  eyeGap: 1000,
  // Starts of one goal kind within a minute: more is a brain restarting what just failed.
  churn: 6,
};
const frameActions = new Set(['sense', 'observe', 'control_frame', 'control_step']);

export class Budget {
  log: Log;
  telemetry: any;
  noted = new Map<string, { count: number; worst: number; at: number }>();
  starts = new Map<string, number[]>();
  delay: any = null;
  timers: any[] = [];
  constructor(log: Log = noLog, telemetry: any = null) {
    this.log = log;
    this.telemetry = telemetry;
  }
  // One measurement against its limit. The first excess is logged at once; later ones are
  // folded into a count and a worst value, reported again after ten seconds.
  over(what: string, value: number, limit: number, detail: Record<string, unknown> = {}, now = Date.now()) {
    if (!(value > limit)) return false;
    const seen = this.noted.get(what) ?? { count: 0, worst: 0, at: 0 };
    seen.count++;
    seen.worst = Math.max(seen.worst, value);
    if (now - seen.at >= 10000) {
      this.log.info('perf', 'over_budget', { what, value: Math.round(value), limit, count: seen.count, worst: Math.round(seen.worst), ...detail });
      this.telemetry?.publish(
        'perf',
        { what, value: Math.round(value), limit, count: seen.count, worst: Math.round(seen.worst), ...detail },
        { log: true },
      );
      seen.at = now;
      seen.count = 0;
      seen.worst = 0;
    }
    this.noted.set(what, seen);
    return true;
  }
  request(action: string, ms: number) {
    const limit = frameActions.has(action) ? budgets.requestFrame : budgets.request;
    this.over(`request:${action}`, ms, limit);
  }
  // What the mod measured about itself, as observe and sense report it.
  mod(performance: any) {
    if (!performance) return;
    if (typeof performance.tickMaxMs === 'number') this.over('mod_tick', performance.tickMaxMs, budgets.modTick);
    if (typeof performance.frameGapMs === 'number') this.over('frame_gap', performance.frameGapMs, budgets.frameGap);
  }
  planning(ms: number) {
    this.over('planning', ms, budgets.planning);
  }
  walkIteration(ms: number) {
    this.over('walk_iteration', ms, budgets.walkIteration);
  }
  eyeGap(ms: number) {
    this.over('eye_gap', ms, budgets.eyeGap);
  }
  churn(kind: string, now = Date.now()) {
    const recent = (this.starts.get(kind) ?? []).filter(at => now - at < 60000);
    recent.push(now);
    this.starts.set(kind, recent);
    this.over(`churn:${kind}`, recent.length, budgets.churn, { perMinute: recent.length }, now);
  }
  // Node's own loop: a histogram of timer delay, and a coarse timer whose lateness is a single stall.
  watchLoop() {
    if (this.delay) return;
    this.delay = monitorEventLoopDelay({ resolution: 20 });
    this.delay.enable();
    let expected = Date.now() + 100;
    this.timers.push(
      setInterval(() => {
        const now = Date.now();
        this.over('loop_stall', now - expected, budgets.loopStall);
        expected = now + 100;
      }, 100).unref(),
      setInterval(() => {
        const p99 = this.delay.percentile(99) / 1e6;
        this.over('loop_lag', p99, budgets.loopLag, { max: Math.round(this.delay.max / 1e6) });
        this.delay.reset();
      }, 5000).unref(),
    );
  }
  close() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.delay?.disable();
    this.delay = null;
  }
}
