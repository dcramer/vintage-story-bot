// Bot client lifecycle on the headless display: start, status, stop, saves. Operator-only; never imports gameplay code.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { botWindow, isBotProcess } from './bot-window.ts';
import { currentDisplay, ensureDisplay, listProcesses, readJson, root, toolEnv } from './display.ts';
import { gameArguments, loadLaunchConfig, updateCharacterName, updateWindowSettings } from './launch-config.ts';
import { requestWindowClose } from './x11.ts';

export const paths = {
  game: `${root}/.runtime/linux-client`,
  dotnet: `${root}/.dotnet/dotnet`,
  botData: `${root}/.runtime/bot-data`,
  state: `${root}/.runtime/game/state.json`,
  stdout: `${root}/.runtime/game/client.out.log`,
};
const modDirectory = `${paths.botData}/Mods/VintageStoryAI`;
const phaseMarkers = [
  ['Received level finalize', 'world_ready'],
  ['Exiting current game to main menu', 'main_menu'],
  ['Cached session key is invalid, require login', 'login_required'],
  ['Received level init', 'loading'],
  ['Server launched', 'loading'],
  ['Server validation response', 'loading'],
];

export function botProcesses() {
  return listProcesses().filter(({ argv }) => isBotProcess(argv, root));
}

const readState = () => readJson(paths.state);

// Game log timestamps are d.M.yyyy H:mm:ss local time.
function logLinesSince(file, since) {
  if (!existsSync(file)) return [];
  const lines = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const stamp = line.match(/^(\d+)\.(\d+)\.(\d+) (\d+):(\d+):(\d+) /);
    if (!stamp) continue;
    const at = new Date(+stamp[3], +stamp[2] - 1, +stamp[1], +stamp[4], +stamp[5], +stamp[6]).getTime();
    if (at >= since - 1000) lines.push(line);
  }
  return lines;
}

function phaseFrom(lines) {
  let phase = 'starting';
  for (const line of lines) {
    for (const [marker, name] of phaseMarkers)
      if (line.includes(marker)) {
        phase = name;
        break;
      }
  }
  return phase;
}

// Pid-verified bot window on the display, or null while none is mapped.
async function windowId(display) {
  if (!display) return null;
  try {
    return (await botWindow(toolEnv(display))).id;
  } catch {
    return null;
  }
}

function currentPhase(state, processes) {
  if (!processes.length) return state ? 'exited' : 'stopped';
  return phaseFrom(logLinesSince(`${paths.botData}/Logs/client-main.log`, state ? Date.parse(state.startedAt) : 0));
}

export async function gameStatus() {
  const state = readState();
  const processes = botProcesses();
  const display = (await currentDisplay())?.display ?? state?.display ?? null;
  return {
    phase: currentPhase(state, processes),
    pids: processes.map(({ pid }) => pid),
    display,
    window: processes.length ? await windowId(display) : null,
    target: state?.target ?? null,
    startedAt: state?.startedAt ?? null,
  };
}

async function waitFor(predicate, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await predicate();
    if (result) return result;
    if (Date.now() > deadline) return null;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

const settled = new Set(['world_ready', 'login_required', 'main_menu', 'exited']);

export async function startGame({ world, create, playStyle, server, display, width, height, wait = true, timeoutMs = 300_000 }: any = {}) {
  const running = botProcesses();
  if (running.length) throw new Error(`Bot client already running (pid ${running.map(p => p.pid).join(', ')}); stop it first.`);
  const config = loadLaunchConfig(root, paths.botData, { world, create, playStyle, server });
  for (const required of [`${paths.game}/Vintagestory.dll`, paths.dotnet, `${modDirectory}/VintageStoryAI.dll`, `${modDirectory}/modinfo.json`]) {
    if (!existsSync(required)) throw new Error(`Missing ${required}; install the client and deploy the mod first.`);
  }
  const screen = await ensureDisplay({ display, width, height });
  updateCharacterName(paths.botData, config.characterName);
  updateWindowSettings(paths.botData, screen);
  const env: Record<string, string | undefined> = {
    ...process.env,
    DOTNET_ROOT: `${root}/.dotnet`,
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    FONTCONFIG_FILE: `${paths.game}/fonts.conf`,
    DISPLAY: screen.display,
    XDG_SESSION_TYPE: 'x11',
    // Xvfb has no sound device; keep OpenAL process-local and silent.
    ALSOFT_DRIVERS: process.env.ALSOFT_DRIVERS ?? 'null',
    VINTAGE_STORY_SERVER_PASSWORD: '',
  };
  delete env.WAYLAND_DISPLAY;
  // WSL: Mesa's D3D12 driver reaches the host GPU through /dev/dxg even on a virtual display.
  if (existsSync('/dev/dxg')) {
    env.GALLIUM_DRIVER ??= 'd3d12';
    env.MESA_D3D12_DEFAULT_ADAPTER_NAME ??= 'NVIDIA';
  }
  mkdirSync(path.dirname(paths.state), { recursive: true });
  const out = openSync(paths.stdout, 'a');
  const child = spawn(paths.dotnet, [`${paths.game}/Vintagestory.dll`, ...gameArguments(config, paths.botData)], {
    cwd: paths.game,
    detached: true,
    stdio: ['ignore', out, out],
    env,
  });
  child.unref();
  const state = {
    pid: child.pid,
    display: screen.display,
    startedAt: new Date().toISOString(),
    target: config.server ? { server: config.server } : { world: config.world, created: Boolean(create) },
  };
  writeFileSync(paths.state, JSON.stringify(state, null, 2));
  if (!wait) return { ...state, phase: 'starting' };
  // Poll only the phase; window discovery and display probes run once the phase settles.
  const done = await waitFor(async () => settled.has(currentPhase(state, botProcesses())), timeoutMs);
  return { ...(await gameStatus()), ...(done ? {} : { timedOut: true }) };
}

// A window-close request takes the game's own exit path on its main thread (saves, stops the singleplayer server).
// SIGTERM only when no window exists yet: the game's signal handler runs off-thread and crashes mid-save.
export async function stopGame({ timeoutMs = 90_000, force = false } = {}) {
  const processes = botProcesses();
  if (!processes.length) {
    rmSync(paths.state, { force: true });
    return { stopped: false, reason: 'not running' };
  }
  const since = Date.now();
  const display = (await currentDisplay())?.display ?? readState()?.display;
  const window = await windowId(display);
  let method = 'sigterm';
  if (window) {
    try {
      await requestWindowClose(display, window);
    } catch (error) {
      return { stopped: false, method: 'close_request', error: error.message, pids: processes.map(({ pid }) => pid) };
    }
    method = 'close_request';
  } else {
    for (const { pid } of processes) process.kill(pid, 'SIGTERM');
  }
  let exited = await waitFor(async () => (botProcesses().length ? null : true), timeoutMs);
  if (!exited && force) {
    for (const { pid } of botProcesses()) process.kill(pid, 'SIGKILL');
    exited = await waitFor(async () => (botProcesses().length ? null : true), 5000);
  }
  const saved = logLinesSince(`${paths.botData}/Logs/server-main.log`, since).some(line => line.includes('World saved!'));
  // Keep the state of a client that is still running so a later stop can still find its display.
  if (exited) rmSync(paths.state, { force: true });
  return { stopped: Boolean(exited), method, saved, forced: force && Boolean(exited), pids: processes.map(({ pid }) => pid) };
}

export function listWorlds() {
  const saves = `${paths.botData}/Saves`;
  if (!existsSync(saves)) return [];
  return readdirSync(saves)
    .filter(name => name.endsWith('.vcdbs'))
    .map(name => {
      const stat = statSync(`${saves}/${name}`);
      return { name: name.slice(0, -'.vcdbs'.length), bytes: stat.size, modified: stat.mtime.toISOString() };
    });
}

export function importWorld(source, name = path.basename(source, '.vcdbs')) {
  if (!source.endsWith('.vcdbs') || !existsSync(source)) throw new Error('Source must be an existing .vcdbs save.');
  if (!name || name.startsWith('.') || /[\\/]/.test(name)) throw new Error('Invalid save name.');
  const target = `${paths.botData}/Saves/${name}.vcdbs`;
  if (existsSync(target)) throw new Error(`Save ${name} already exists.`);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
  return { name, bytes: statSync(target).size };
}
