// Controller (Node bot) process lifecycle: find, stop, start detached. Operator-only; never imports gameplay code.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { listProcesses, root } from './display.ts';

const scriptReal = (() => {
  try {
    return realpathSync(`${root}/src/bot.ts`);
  } catch {
    return null;
  }
})();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A node process running this checkout's src/bot.ts (argv may hold it relative; resolve against its cwd).
export function isControllerProcess(argv, pid) {
  if (pid === process.pid || !/(^|\/)node$/.test(argv[0] ?? '') || !scriptReal) return false;
  let cwd;
  try {
    cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return false;
  }
  return argv.some(arg => {
    if (!arg.endsWith('src/bot.ts')) return false;
    try {
      return realpathSync(path.isAbsolute(arg) ? arg : path.join(cwd, arg)) === scriptReal;
    } catch {
      return false;
    }
  });
}

export function controllerProcesses() {
  return listProcesses().filter(({ argv, pid }) => isControllerProcess(argv, pid));
}

export function processEnv(pid) {
  const env = {};
  for (const entry of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
    if (!entry) continue;
    const index = entry.indexOf('=');
    if (index > 0) env[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return env;
}

export function processCwd(pid) {
  return readlinkSync(`/proc/${pid}/cwd`);
}

export function processExe(pid) {
  return readlinkSync(`/proc/${pid}/exe`);
}

export function controllerPortFrom(env) {
  const value = env.VINTAGE_STORY_CONTROLLER_PORT ?? '42158';
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('VINTAGE_STORY_CONTROLLER_PORT must be an integer from 1 to 65535.');
  }
  return Number(value);
}

function zombie(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(') ') + 2)[0] === 'Z';
  } catch {
    return false;
  }
}

async function gone(pid) {
  if (zombie(pid)) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

// SIGTERM is the controller's own clean shutdown (cancels goals, closes the session log).
export async function stopController(pid, timeoutMs = 15000, { force = false } = {}) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH') return { stopped: true, pid, forced: false };
    throw error;
  }
  if (await exited(pid, timeoutMs)) return { stopped: true, pid, forced: false };
  if (!force) return { stopped: false, pid };
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return { stopped: true, pid, forced: true };
  }
  return { stopped: await exited(pid, 5000), pid, forced: true };
}

async function exited(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!(await gone(pid))) {
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
  return true;
}

export const controllerOutLog = port => `${root}/.runtime/logs/controller-${port}.out.log`;

export function startController({ exe, args, cwd, env, outLog }) {
  mkdirSync(path.dirname(outLog), { recursive: true });
  const out = openSync(outLog, 'a');
  const child = spawn(exe, args, { cwd, detached: true, stdio: ['ignore', out, out], env });
  child.unref();
  return { pid: child.pid, outLog };
}

export function probePort(port, timeoutMs = 1000) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = up => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probePort(port)) return true;
    if (Date.now() > deadline) return false;
    await sleep(500);
  }
}
