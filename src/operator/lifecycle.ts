// Shared bits of the start/stop/restart/status lifecycle. Operator-only; never imports gameplay code.
import { spawnSync } from 'node:child_process';
import { root } from './display.ts';

export function fail(message) {
  console.error(`FAILED: ${message}`);
  process.exit(1);
}

// pnpm appends `restart -- <args>` to every lifecycle phase, so all phases share one flag set.
export function parseLifecycleArgs(argv, usage) {
  const flags = { force: false, noWait: false };
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--force') flags.force = true;
    else if (arg === '--no-wait') flags.noWait = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(usage);
      process.exit(0);
    } else if (arg === '--brain') {
      fail('pass the brain through the environment instead: VINTAGE_STORY_BRAIN=default in .env.');
    } else fail(`Unknown flag ${arg}.\n${usage}`);
  }
  return flags;
}

export function ensureDeps() {
  const install = spawnSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { cwd: root, encoding: 'utf8' });
  if (install.error || install.status !== 0) {
    fail(
      `deps failed${install.error ? `: ${install.error.message}` : `:\n${`${install.stdout}${install.stderr}`.trim().split('\n').slice(-12).join('\n')}`}`,
    );
  }
}

// State target (survives a crash; a clean stop removes it), else .env defaults, else none.
export function resolveTarget(status) {
  if (status.target?.server) return { server: status.target.server };
  if (status.target?.world) return { world: status.target.world };
  if (process.env.VINTAGE_STORY_WORLD || process.env.VINTAGE_STORY_SERVER) return {};
  return null;
}
