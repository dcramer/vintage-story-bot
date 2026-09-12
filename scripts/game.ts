// Standard Linux entrypoint: headless bot client lifecycle, saves and operator menu input. Output is JSON.
import { writeFileSync } from 'node:fs';
import { callUi, typeText } from '../src/operator/bot-window.ts';
import { displayStatus, ensureDisplay, stopDisplay } from '../src/operator/display.ts';
import { botProcesses, buildMod, gameStatus, importWorld, installMod, listWorlds, reinstallMod, startGame, stopGame } from '../src/operator/game.ts';
import { syncNativeMap } from '../src/operator/native-map.ts';
import { captureWorldMap } from '../src/operator/world-map.ts';

const usage = `Usage: game.ts <command>
  start [--world NAME | --new NAME [--play-style STYLE] | --server HOST[:PORT]] [--display :N] [--size WxH] [--no-wait] [--timeout SEC]
  stop [--force]            window-close request = game's own saving exit path; --force SIGKILLs after the timeout
  status | worlds | import <file.vcdbs> [NAME]
  mod build | mod install [--no-build] | mod reinstall [--no-build] [--no-wait]   (install needs a stopped client; reinstall stops and restarts it)
  display start|stop|status [--display :N] [--size WxH]
  screenshot [FILE.png] | map | click X Y | key KEY | type   (type reads one line from stdin; operator sign-in only)`;

const [command, ...rest] = process.argv.slice(2);
const flags: Record<string, any> = {},
  positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  if (!arg.startsWith('--')) {
    positional.push(arg);
    continue;
  }
  const name = arg.slice(2);
  if (['no-wait', 'force', 'no-build'].includes(name)) flags[name] = true;
  else flags[name] = rest[++i];
}
const size = flags.size ? flags.size.match(/^(\d+)x(\d+)$/) : null;
if (flags.size && !size) fail('--size must look like 1280x720.');
const screen = { display: flags.display, width: size ? Number(size[1]) : undefined, height: size ? Number(size[2]) : undefined };

function fail(message) {
  console.error(message);
  process.exit(1);
}
function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function run() {
  switch (command) {
    case 'start':
      return print(
        await startGame({
          ...screen,
          world: flags.world,
          create: flags.new,
          playStyle: flags['play-style'],
          server: flags.server,
          wait: !flags['no-wait'],
          ...(flags.timeout ? { timeoutMs: Number(flags.timeout) * 1000 } : {}),
        }),
      );
    case 'stop':
      return print(await stopGame({ force: Boolean(flags.force), ...(flags.timeout ? { timeoutMs: Number(flags.timeout) * 1000 } : {}) }));
    case 'status':
      return print(await gameStatus());
    case 'worlds':
      return print(listWorlds());
    case 'mod':
      if (positional[0] === 'build') return print(buildMod());
      if (positional[0] === 'install') return print(installMod({ build: !flags['no-build'] }));
      if (positional[0] === 'reinstall') return print(await reinstallMod({ build: !flags['no-build'], wait: !flags['no-wait'] }));
      return fail(usage);
    case 'import':
      return print(importWorld(positional[0] ?? fail(usage), positional[1]));
    case 'display':
      if (positional[0] === 'start') return print(await ensureDisplay(screen));
      if (positional[0] === 'stop') {
        if (botProcesses().length) return fail('Stop the bot client first; killing its display would crash it without saving.');
        return print(await stopDisplay());
      }
      if (positional[0] === 'status') return print(await displayStatus());
      return fail(usage);
    case 'screenshot': {
      const result = await callUi('ui_screenshot', {});
      const image = Buffer.from(result.content[1].data, 'base64');
      const file = positional[0] ?? `${process.cwd()}/bot-window.png`;
      writeFileSync(file, image);
      return print({ ...JSON.parse(result.content[0].text), file });
    }
    case 'map': {
      const { image: _image, ...result } = await captureWorldMap();
      return print({ ...result, native: result.captured ? await syncNativeMap() : null });
    }
    case 'click':
      return print(JSON.parse((await callUi('ui_click', { x: Number(positional[0]), y: Number(positional[1]) })).content[0].text));
    case 'key':
      return print(JSON.parse((await callUi('ui_key', { key: positional[0] })).content[0].text));
    case 'type': {
      let text = '';
      for await (const chunk of process.stdin) text += chunk;
      return print(await typeText(text.replace(/\r?\n$/, '')));
    }
    default:
      return fail(usage);
  }
}

try {
  await run();
} catch (error) {
  fail(error.message);
}
