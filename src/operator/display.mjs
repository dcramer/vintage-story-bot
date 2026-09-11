// Private headless X display for the bot client (Linux). System X11 tools win; scripts/setup-linux.sh
// unpacks them into .runtime/x11 without root. WSLg mounts /tmp/.X11-unix read-only and Xvfb hardcodes
// /usr/bin/xkbcomp, so Xvfb runs inside bubblewrap when either is unavailable; clients still reach it
// through the abstract socket, so a plain DISPLAY works outside the sandbox.
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { socketPath } from './x11.mjs';

export const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
// Repository .env supplies defaults; existing environment variables win.
if (existsSync(`${root}/.env`)) loadEnvFile(`${root}/.env`);
export const x11Root = `${root}/.runtime/x11`;
const stateFile = `${x11Root}/display.json`;
export const defaultDisplay = process.env.VINTAGE_STORY_DISPLAY || ':7';
export const defaultSize = { width: 1920, height: 1080 };

export function tool(name) {
  for (const dir of (process.env.PATH ?? '').split(':')) if (dir && existsSync(`${dir}/${name}`)) return `${dir}/${name}`;
  const local = `${x11Root}/usr/bin/${name}`;
  return existsSync(local) ? local : null;
}

export function toolEnv(display) {
  const lib = `${x11Root}/usr/lib/x86_64-linux-gnu`;
  return {
    ...process.env,
    ...(display ? { DISPLAY: display } : {}),
    LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ? `${lib}:${process.env.LD_LIBRARY_PATH}` : lib,
  };
}

export function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function processArgv(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return null; }
}

export function listProcesses() {
  const processes = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const argv = processArgv(entry);
    if (argv?.length) processes.push({ pid: Number(entry), argv });
  }
  return processes;
}

export function probeDisplay(display, timeoutMs = 1000) {
  const path = socketPath(display);
  return new Promise(resolve => {
    const socket = net.connect({ path });
    const done = up => { socket.destroy(); resolve(up); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isXvfb(pid) {
  const argv = processArgv(pid);
  return Boolean(argv && /(^|\/)Xvfb$/.test(argv[0]));
}

function serverProcess(display) {
  return listProcesses().find(({ argv }) => /(^|\/)Xvfb$/.test(argv[0] ?? '') && argv[1] === display) ?? null;
}

// Display recorded by ensureDisplay and currently serving, or null. External servers are adopted, not owned.
export async function currentDisplay() {
  const state = readJson(stateFile);
  if (!state) return null;
  if (!state.external && !(state.pid && isXvfb(state.pid))) return null;
  return (await probeDisplay(state.display)) ? state : null;
}

function sandboxReasons() {
  const reasons = [];
  if (existsSync('/tmp/.X11-unix')) {
    try { accessSync('/tmp/.X11-unix', constants.W_OK); } catch { reasons.push('/tmp/.X11-unix is read-only'); }
  }
  if (!existsSync('/usr/bin/xkbcomp')) reasons.push('/usr/bin/xkbcomp is missing');
  return reasons;
}

// Replacement /usr/bin for the sandbox: only what Xvfb resolves there (xkbcomp through /bin/sh, and Xvfb itself
// when it is the system binary); the real directory stays reachable as /opt/hostbin.
function buildHostBinOverlay(xvfb) {
  const overlay = `${x11Root}/hostbin`;
  rmSync(overlay, { recursive: true, force: true });
  mkdirSync(overlay, { recursive: true });
  const xkbcomp = tool('xkbcomp');
  if (!xkbcomp) throw new Error('xkbcomp is missing; run scripts/setup-linux.sh.');
  symlinkSync(xkbcomp, `${overlay}/xkbcomp`);
  symlinkSync('/opt/hostbin/sh', `${overlay}/sh`);
  if (xvfb.startsWith('/usr/bin/')) symlinkSync(`/opt/hostbin/${xvfb.slice('/usr/bin/'.length)}`, `${overlay}/${xvfb.slice('/usr/bin/'.length)}`);
  return overlay;
}

function writeState(state) {
  mkdirSync(x11Root, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return state;
}

export async function ensureDisplay({ display = defaultDisplay, width = defaultSize.width, height = defaultSize.height } = {}) {
  if (process.platform !== 'linux') throw new Error('Headless display requires Linux.');
  const running = await currentDisplay();
  if (running?.display === display) return { ...running, started: false };
  if (await probeDisplay(display)) {
    return { ...writeState({ display, width, height, pid: null, external: true, sandboxed: false, startedAt: new Date().toISOString() }), started: false };
  }
  const xvfb = tool('Xvfb');
  if (!xvfb) throw new Error('Xvfb is missing; run scripts/setup-linux.sh.');
  const reasons = sandboxReasons();
  const xkbdir = existsSync('/usr/share/X11/xkb') ? [] : ['-xkbdir', `${x11Root}/usr/share/X11/xkb`];
  const xvfbArgs = [display, '-screen', '0', `${width}x${height}x24`, '+extension', 'GLX', '+render', '-noreset', '-nolisten', 'tcp', ...xkbdir];
  let command = xvfb, args = xvfbArgs;
  if (reasons.length) {
    const bwrap = tool('bwrap');
    if (!bwrap) throw new Error(`bubblewrap is required (${reasons.join('; ')}); install bwrap.`);
    command = bwrap;
    args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--bind', '/tmp', '/tmp', '--tmpfs', '/tmp/.X11-unix',
      '--tmpfs', '/opt', '--ro-bind', '/usr/bin', '/opt/hostbin', '--ro-bind', buildHostBinOverlay(xvfb), '/usr/bin', '--', xvfb, ...xvfbArgs];
  }
  mkdirSync(x11Root, { recursive: true });
  const log = openSync(`${x11Root}/Xvfb.log`, 'a');
  const child = spawn(command, args, { detached: true, stdio: ['ignore', log, log], env: toolEnv() });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (!(await probeDisplay(display, 500))) {
    if (Date.now() > deadline || child.exitCode !== null) {
      throw new Error(`Xvfb did not start on ${display}; see ${x11Root}/Xvfb.log.`);
    }
    await sleep(100);
  }
  const state = writeState({ display, width, height, pid: serverProcess(display)?.pid ?? child.pid, external: false, sandboxed: reasons.length > 0, startedAt: new Date().toISOString() });
  return { ...state, started: true };
}

export async function stopDisplay() {
  const state = readJson(stateFile);
  const server = state && !state.external ? serverProcess(state.display) : null;
  if (server) process.kill(server.pid, 'SIGTERM');
  rmSync(stateFile, { force: true });
  return { display: state?.display ?? null, stopped: Boolean(server), external: Boolean(state?.external) };
}

export async function displayStatus() {
  const state = readJson(stateFile);
  return {
    display: state?.display ?? defaultDisplay,
    serving: await probeDisplay(state?.display ?? defaultDisplay),
    ...(state ?? {}),
  };
}
