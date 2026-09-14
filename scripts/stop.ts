// Stop the bot: saving game stop, then controllers. Idempotent.
import { controllerProcesses, stopController } from '../src/operator/controller.ts';
import { gameStatus, stopGame } from '../src/operator/game.ts';
import { fail, parseLifecycleArgs } from '../src/operator/lifecycle.ts';

const usage = `Usage: stop [--force] [--no-wait] (lifecycle-shared flags; stop honors --force)
  Stop the game (its own saving exit) and the controllers. Idempotent.`;
const { force } = parseLifecycleArgs(process.argv.slice(2), usage);

try {
  if ((await gameStatus()).pids.length) {
    const stopped = await stopGame({ force });
    if (!stopped.stopped) fail(`game did not stop (${stopped.method}); try: pnpm game stop --force`);
    console.log(`game stopped (${stopped.method}${stopped.saved ? ', saved' : ''}${stopped.forced ? ', forced' : ''})`);
  } else {
    console.log('game already stopped');
  }
  const controllers = controllerProcesses();
  if (!controllers.length) console.log('controller already stopped');
  for (const { pid } of controllers) {
    const stopped = await stopController(pid, 15000, { force });
    if (!stopped.stopped) fail(`controller ${pid} did not stop; try: kill -9 ${pid}`);
    console.log(`controller ${pid} stopped${stopped.forced ? ' (forced)' : ''}`);
  }
} catch (error) {
  fail(error.message);
}
