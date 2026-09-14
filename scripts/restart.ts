// Update step of `pnpm restart` (stop, restart, start): deps, mod rebuild + install when stale.
import { buildMod, gameStatus, installMod, modInstallState } from '../src/operator/game.ts';
import { ensureDeps, fail, parseLifecycleArgs } from '../src/operator/lifecycle.ts';

const usage = `Usage: restart [--force] [--no-wait] (lifecycle-shared flags; restart honors --force)
  Update step of \`pnpm restart\`: deps, mod rebuild + install when stale. The game must be stopped.`;
const { force } = parseLifecycleArgs(process.argv.slice(2), usage);

try {
  const t0 = Date.now();
  ensureDeps();
  console.log(`deps ok (${Math.round((Date.now() - t0) / 1000)}s)`);
  if ((await gameStatus()).pids.length) fail('game is running; run the full restart: pnpm restart');
  if (force || modInstallState() !== 'current') {
    const built = buildMod();
    installMod({ build: false });
    console.log(`mod rebuilt (${built.warnings} warnings), installed`);
  } else {
    console.log('mod current');
  }
} catch (error) {
  fail(error.message);
}
