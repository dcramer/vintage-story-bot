// Start the bot: bring up what is down (game, controller), then report readiness. Idempotent.
import { controllerOutLog, controllerPortFrom, controllerProcesses, probePort, startController, waitForPort } from '../src/operator/controller.ts';
import { root } from '../src/operator/display.ts';
import { buildMod, gameStatus, installMod, modInstallState, startGame } from '../src/operator/game.ts';
import { ensureDeps, fail, parseLifecycleArgs, resolveTarget } from '../src/operator/lifecycle.ts';
import { collectStatus, printStatus } from './status.ts';

const usage = `Usage: start [--force] [--no-wait] (lifecycle-shared flags; start honors --no-wait)
  Bring up what is down: deps, mod install if missing, controller, game, readiness report. Idempotent.
  The brain comes from VINTAGE_STORY_BRAIN in .env. Exit 1 unless READY.`;
const { noWait } = parseLifecycleArgs(process.argv.slice(2), usage);

try {
  const t0 = Date.now();
  ensureDeps();
  console.log(`deps ok (${Math.round((Date.now() - t0) / 1000)}s)`);
  const mod = modInstallState();
  const status = await gameStatus();
  const running = status.pids.length > 0;
  if (mod === 'missing') {
    if (running) fail('game is running with its mod files removed; run: pnpm stop');
    const built = buildMod();
    installMod({ build: false });
    console.log(`mod built (${built.warnings} warnings), installed`);
  } else if (mod === 'stale') {
    console.log('mod stale: pnpm restart to rebuild');
  } else {
    console.log('mod current');
  }
  const controllers = controllerProcesses();
  let outLog = null;
  if (!controllers.length) {
    const port = controllerPortFrom(process.env);
    if (await probePort(port)) fail(`port ${port} is held by something else; not starting a duplicate controller.`);
    const child = startController({
      exe: process.execPath,
      args: ['--env-file-if-exists=.env', 'src/bot.ts'],
      cwd: root,
      env: process.env,
      outLog: controllerOutLog(port),
    });
    outLog = child.outLog;
    console.log(`controller started: pid ${child.pid}, port ${port}`);
    console.log(`controller log: ${outLog}`);
    if (!noWait && !(await waitForPort(port, 30000))) fail(`controller did not listen on ${port}; see ${outLog}.`);
  } else {
    console.log(`controller already running (pid ${controllers.map(c => c.pid).join(', ')})`);
  }
  const target = resolveTarget(status);
  if (!running && target) {
    const started = await startGame({ ...target, ...(status.display ? { display: status.display } : {}), wait: !noWait });
    console.log(`game started: ${started.phase}${(started as any).timedOut ? ' (timed out waiting)' : ''}`);
  } else if (!running) {
    console.log('game left stopped: no world or server configured (VINTAGE_STORY_WORLD / VINTAGE_STORY_SERVER).');
  } else {
    console.log('game already running');
  }
  if (noWait) {
    console.log(`done (${Math.round((Date.now() - t0) / 1000)}s); check with: pnpm status`);
    process.exit(0);
  }
  const report = await collectStatus(30000);
  printStatus(report, Date.now() - t0);
  process.exitCode = report.ready ? 0 : 1;
} catch (error) {
  fail(error.message);
}
