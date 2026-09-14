// Bot status: game, controller, mod, readiness. Exit 0; start.ts reuses the report.
import { pathToFileURL } from 'node:url';
import { controllerPortFrom, controllerProcesses, probePort, processEnv } from '../src/operator/controller.ts';
import { gameStatus, modInstallState } from '../src/operator/game.ts';
import { fail, parseLifecycleArgs, resolveTarget } from '../src/operator/lifecycle.ts';
import { findTool } from '../src/runtime/registry.ts';
import { requestController } from '../src/runtime/rpc.ts';

const usage = `Usage: status [--force] [--no-wait] (lifecycle-shared flags; status honors neither)
  Report game, controller, mod and readiness. Exit 0.`;
const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) parseLifecycleArgs(process.argv.slice(2), usage);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function action(name) {
  const tool = findTool(name);
  return requestController({ action: tool.action ?? tool.name });
}

export async function collectStatus(timeoutMs = 10000) {
  const game = await gameStatus();
  const gameUp = game.pids.length > 0;
  const controllers = controllerProcesses().map(({ pid }) => {
    let port = null;
    try {
      port = controllerPortFrom(processEnv(pid));
    } catch {
      /* Unreadable env; report without the port. */
    }
    return { pid, port };
  });
  const mod = modInstallState();
  const localUp = controllers.length > 0 && (await probePort(controllerPortFrom(process.env)));
  // A down game cannot become ready; poll only while it is up (the bridge may still be coming).
  const budget = gameUp ? timeoutMs : 0;
  let observe = null;
  if (localUp) {
    const deadline = Date.now() + budget;
    for (;;) {
      try {
        observe = await action('observe');
        if (observe?.controlReady) break;
      } catch {
        observe = null;
      }
      if (Date.now() > deadline) break;
      await sleep(2000);
    }
  }
  let dialogs = null;
  if (localUp && !observe?.controlReady) {
    try {
      dialogs = await action('dialogs');
    } catch {
      /* Report without them. */
    }
  }
  return {
    game,
    gameUp,
    controllers,
    mod,
    observe,
    dialogs,
    targetKnown: Boolean(resolveTarget(game)),
    ready: gameUp && observe?.controlReady === true,
  };
}

export function printStatus(status, elapsedMs) {
  const { game, gameUp, controllers, mod, dialogs, targetKnown, ready } = status;
  const target = game.target ? (`server` in game.target ? `server ${game.target.server}` : `world ${game.target.world}`) : null;
  console.log(
    `game: ${game.phase}${gameUp ? ` (pid ${game.pids.join(', ')}${target ? `, ${target}` : ''}${game.display ? `, ${game.display}` : ''})` : ''}`,
  );
  console.log(
    controllers.length ? `controller: ${controllers.map(c => `pid ${c.pid}${c.port ? `, port ${c.port}` : ''}`).join('; ')}` : 'controller: stopped',
  );
  console.log(`mod: ${mod}${mod === 'stale' ? ' (pnpm restart to rebuild)' : ''}${mod === 'missing' ? ' (pnpm restart to install)' : ''}`);
  if (ready) {
    console.log(`READY (${Math.round(elapsedMs / 1000)}s)`);
    return;
  }
  console.log(`NOT READY (${Math.round(elapsedMs / 1000)}s):`);
  if (!controllers.length) console.log('- controller is stopped; start it: pnpm start');
  else if (!status.observe) console.log("- controller is not answering on this checkout's port (VINTAGE_STORY_CONTROLLER_PORT)");
  if (!gameUp) console.log(`- game is stopped; start it: ${targetKnown ? 'pnpm start' : 'pnpm game start --world NAME'}`);
  else if (game.phase !== 'world_ready') console.log(`- game is ${game.phase}; wait or check: pnpm game status`);
  else if (status.observe && !status.observe.controlReady) {
    const blocking = dialogs?.dialogs?.filter(dialog => dialog.blocksControl) ?? [];
    if (blocking.length) {
      for (const dialog of blocking) {
        const elements = dialog.elements?.filter(element => element.enabled).map(element => element.key) ?? [];
        console.log(`- blocking dialog ${dialog.name}: ${elements.join(', ')}`);
      }
      const first = blocking[0].elements?.find(element => element.enabled)?.key;
      console.log(`  clear it: node scripts/control.ts activate_dialog --json '{"dialog":"${blocking[0].name}","element":"${first}"}'`);
    } else {
      console.log('- control not ready; inspect: node scripts/control.ts observe');
    }
  }
}

if (direct) {
  const t0 = Date.now();
  try {
    printStatus(await collectStatus(), Date.now() - t0);
  } catch (error) {
    fail(error.message);
  }
}
