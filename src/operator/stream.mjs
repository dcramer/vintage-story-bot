// Live view of the headless display for observers: ffmpeg grabs the bot's X display and pushes H.264 to a local
// mediamtx, which serves the picture over RTSP (TCP), HLS and WebRTC to any number of viewers. Operator-only,
// read-only and unauthenticated: it shows what the client window shows, nothing more. Never imports gameplay code.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { currentDisplay, defaultDisplay, processArgv, readJson, root, tool, toolEnv } from './display.mjs';
import { gameStatus } from './game.mjs';

const dir = `${root}/.runtime/stream`;
export const paths = {
  mediamtx: `${root}/.runtime/tools/mediamtx`,
  config: `${dir}/mediamtx.yml`,
  state: `${dir}/state.json`,
  serverLog: `${dir}/mediamtx.log`,
  encoderLog: `${dir}/ffmpeg.log`,
};
export const defaults = { fps: 20, kbps: 4000, bind: '0.0.0.0', rtspPort: 8554, hlsPort: 8888, webrtcPort: 8889, name: 'bot' };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function running(pid, binary) {
  const argv = pid ? processArgv(pid) : null;
  return Boolean(argv && new RegExp(`(^|/)${binary}$`).test(argv[0]));
}

function portOpen(port, timeoutMs = 500) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = up => { socket.destroy(); resolve(up); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// NVENC when the GPU and driver expose it (WSL does), else software x264 tuned for latency over quality.
function chooseEncoder(ffmpeg) {
  const forced = process.env.VINTAGE_STORY_STREAM_ENCODER;
  if (forced) return forced;
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=5', '-frames:v', '2', '-c:v', 'h264_nvenc', '-f', 'null', '-'],
      { stdio: 'ignore', timeout: 10_000 });
    return 'h264_nvenc';
  } catch { return 'libx264'; }
}

function encoderArgs(encoder, fps, kbps) {
  const keyframes = String(fps * 2);
  const rate = ['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-g', keyframes, '-pix_fmt', 'yuv420p'];
  if (encoder === 'h264_nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-rc', 'cbr', '-bf', '0', ...rate];
  return ['-c:v', encoder, '-preset', 'ultrafast', '-tune', 'zerolatency', ...rate];
}

function serverConfig({ bind, rtspPort, hlsPort, webrtcPort, name }) {
  return [
    'logLevel: info', 'logDestinations: [stdout]',
    'api: false', 'metrics: false', 'pprof: false', 'playback: false', 'rtmp: false', 'srt: false',
    'rtsp: true', `rtspAddress: ${bind}:${rtspPort}`, 'rtspTransports: [tcp]', 'rtspEncryption: "no"',
    'hls: true', `hlsAddress: ${bind}:${hlsPort}`, 'hlsVariant: lowLatency',
    'webrtc: true', `webrtcAddress: ${bind}:${webrtcPort}`,
    'paths:', `  ${name}:`, '    source: publisher', '',
  ].join('\n');
}

function hosts() {
  const addresses = ['localhost'];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
  }
  return addresses;
}

function urls(state) {
  const host = hosts()[1] ?? 'localhost';
  return {
    rtsp: `rtsp://${host}:${state.rtspPort}/${state.name}`,
    hls: `http://${host}:${state.hlsPort}/${state.name}`,
    webrtc: `http://${host}:${state.webrtcPort}/${state.name}`,
  };
}

export async function streamStatus() {
  const state = readJson(paths.state);
  if (!state) return { streaming: false };
  const server = running(state.serverPid, 'mediamtx');
  const encoder = running(state.encoderPid, 'ffmpeg');
  return { streaming: server && encoder, server, encoder, ...state, urls: urls(state), hosts: hosts() };
}

export async function startStream({ display, fps = defaults.fps, kbps = defaults.kbps, bind = defaults.bind } = {}) {
  const status = await streamStatus();
  if (status.streaming) return { ...status, started: false };
  if (status.server || status.encoder) await stopStream();
  const ffmpeg = tool('ffmpeg');
  if (!ffmpeg) throw new Error('ffmpeg is missing; install it with your package manager.');
  if (!existsSync(paths.mediamtx)) throw new Error(`${paths.mediamtx} is missing; run scripts/setup-linux.sh.`);
  const screen = await currentDisplay();
  display ??= screen?.display ?? defaultDisplay;
  if (!screen || screen.display !== display) throw new Error(`Display ${display} is not serving; start the game or the display first.`);
  // The sign-in screen stays private: nothing typed there should reach an unauthenticated stream.
  if ((await gameStatus()).phase === 'login_required') throw new Error('The client is on the sign-in screen; complete sign-in before streaming.');

  const state = { ...defaults, bind, fps, kbps, display, width: screen.width, height: screen.height, startedAt: new Date().toISOString() };
  mkdirSync(dir, { recursive: true });
  writeFileSync(paths.config, serverConfig(state));
  const serverLog = openSync(paths.serverLog, 'a');
  const server = spawn(paths.mediamtx, [paths.config], { cwd: dir, detached: true, stdio: ['ignore', serverLog, serverLog] });
  server.unref();
  const deadline = Date.now() + 10_000;
  while (!(await portOpen(state.rtspPort))) {
    if (Date.now() > deadline || server.exitCode !== null) {
      if (server.exitCode === null) process.kill(server.pid, 'SIGTERM');
      throw new Error(`mediamtx did not open port ${state.rtspPort}; see ${paths.serverLog}.`);
    }
    await sleep(100);
  }

  state.codec = chooseEncoder(ffmpeg);
  const encoderLog = openSync(paths.encoderLog, 'a');
  const encoder = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    '-f', 'x11grab', '-framerate', String(fps), '-video_size', `${screen.width}x${screen.height}`, '-draw_mouse', '0', '-i', display,
    ...encoderArgs(state.codec, fps, kbps),
    '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://127.0.0.1:${state.rtspPort}/${state.name}`,
  ], { cwd: dir, detached: true, stdio: ['ignore', encoderLog, encoderLog], env: toolEnv(display) });
  encoder.unref();
  state.serverPid = server.pid;
  state.encoderPid = encoder.pid;
  writeFileSync(paths.state, JSON.stringify(state, null, 2));
  await sleep(1500);
  if (encoder.exitCode !== null) {
    await stopStream();
    throw new Error(`ffmpeg exited with ${encoder.exitCode}; see ${paths.encoderLog}.`);
  }
  return { ...(await streamStatus()), started: true };
}

export async function stopStream() {
  const state = readJson(paths.state);
  const stopped = [];
  for (const [key, binary] of [['encoderPid', 'ffmpeg'], ['serverPid', 'mediamtx']]) {
    if (!running(state?.[key], binary)) continue;
    process.kill(state[key], 'SIGTERM');
    stopped.push(binary);
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (running(state?.encoderPid, 'ffmpeg') || running(state?.serverPid, 'mediamtx'))) await sleep(100);
  rmSync(paths.state, { force: true });
  return { stopped };
}
