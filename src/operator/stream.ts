// Live view of the headless display, owned by the dashboard process: ffmpeg grabs the bot's X display and pushes
// H.264 to a local mediamtx, which serves RTSP (TCP), HLS and WebRTC to any number of viewers. The supervisor keeps
// both alive while a display is serving, waits while there is none, and takes both down when the dashboard exits.
// Operator-only, read-only and unauthenticated: it shows what the client window shows, nothing more.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { currentDisplay, listProcesses, root, tool } from './display.ts';
import { gameStatus } from './game.ts';

const dir = `${root}/.runtime/stream`;
export const paths = {
  mediamtx: `${root}/.runtime/tools/mediamtx`,
  config: `${dir}/mediamtx.yml`,
  serverLog: `${dir}/mediamtx.log`,
  encoderLog: `${dir}/ffmpeg.log`,
};
export const defaults = { fps: 20, kbps: 4000, bind: '0.0.0.0', rtspPort: 8554, hlsPort: 8888, webrtcPort: 8889, name: 'bot' };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function portOpen(port, timeoutMs = 500) {
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

// NVENC when the GPU and driver expose it (WSL does), else software x264 tuned for latency over quality.
function chooseEncoder(ffmpeg) {
  const forced = process.env.VINTAGE_STORY_STREAM_ENCODER;
  if (forced) return forced;
  try {
    execFileSync(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x180:rate=5',
        '-frames:v',
        '2',
        '-c:v',
        'h264_nvenc',
        '-f',
        'null',
        '-',
      ],
      { stdio: 'ignore', timeout: 10_000 },
    );
    return 'h264_nvenc';
  } catch {
    return 'libx264';
  }
}

function encoderArgs(codec, fps, kbps) {
  const rate = ['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-g', String(fps * 2), '-pix_fmt', 'yuv420p'];
  if (codec === 'h264_nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-rc', 'cbr', '-bf', '0', ...rate];
  return ['-c:v', codec, '-preset', 'ultrafast', '-tune', 'zerolatency', ...rate];
}

function serverConfig({ bind, rtspPort, hlsPort, webrtcPort, name }) {
  return [
    'logLevel: info',
    'logDestinations: [stdout]',
    'api: false',
    'metrics: false',
    'pprof: false',
    'playback: false',
    'rtmp: false',
    'srt: false',
    'rtsp: true',
    `rtspAddress: ${bind}:${rtspPort}`,
    'rtspTransports: [tcp]',
    'rtspEncryption: "no"',
    'hls: true',
    `hlsAddress: ${bind}:${hlsPort}`,
    'hlsVariant: lowLatency',
    'webrtc: true',
    `webrtcAddress: ${bind}:${webrtcPort}`,
    'paths:',
    `  ${name}:`,
    '    source: publisher',
    '',
  ].join('\n');
}

function hosts() {
  const addresses = ['localhost'];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
  }
  return addresses;
}

// Children of a dashboard that died without cleaning up: same config file or same publish target.
function killStale(options) {
  const target = `rtsp://127.0.0.1:${options.rtspPort}/${options.name}`;
  for (const { pid, argv } of listProcesses()) {
    if (pid === process.pid) continue;
    const stale = (/(^|\/)mediamtx$/.test(argv[0]) && argv[1] === paths.config) || (/(^|\/)ffmpeg$/.test(argv[0]) && argv.includes(target));
    if (stale) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
  }
}

// Starts the supervisor; `onChange(status)` fires whenever server or encoder liveness changes.
export function superviseStream({
  fps = defaults.fps,
  kbps = defaults.kbps,
  bind = defaults.bind,
  onChange = (_status?: any) => {},
  log = (_line?: any) => {},
} = {}) {
  const options = { ...defaults, fps, kbps, bind };
  const ffmpeg = tool('ffmpeg');
  const missing = !ffmpeg
    ? 'ffmpeg is missing; install it with your package manager.'
    : !existsSync(paths.mediamtx)
      ? `${paths.mediamtx} is missing; run scripts/setup-linux.sh.`
      : null;
  let server = null,
    encoder = null,
    display = null,
    codec = null,
    stopping = false,
    reason = missing;
  const status = () => ({
    streaming: Boolean(server && encoder),
    server: Boolean(server),
    encoder: Boolean(encoder),
    display,
    codec,
    reason,
    fps,
    kbps,
    hosts: hosts(),
    urls: {
      rtsp: `rtsp://HOST:${options.rtspPort}/${options.name}`,
      hls: `http://HOST:${options.hlsPort}/${options.name}/`,
      webrtc: `http://HOST:${options.webrtcPort}/${options.name}/`,
    },
  });
  const changed = () => onChange(status());

  async function ensureServer() {
    if (server) return true;
    if (await portOpen(options.rtspPort)) {
      killStale(options);
      await sleep(1000);
    }
    if (await portOpen(options.rtspPort)) {
      reason = `port ${options.rtspPort} is in use by another process`;
      return false;
    }
    writeFileSync(paths.config, serverConfig(options));
    const out = openSync(paths.serverLog, 'a');
    const child = spawn(paths.mediamtx, [paths.config], { cwd: dir, stdio: ['ignore', out, out] });
    child.once('exit', code => {
      if (server === child) {
        server = null;
        reason = `mediamtx exited (${code}); see ${paths.serverLog}`;
        log(reason);
        changed();
      }
    });
    server = child;
    const deadline = Date.now() + 10_000;
    while (!(await portOpen(options.rtspPort))) {
      if (child.exitCode !== null || Date.now() > deadline) {
        if (child.exitCode === null) child.kill('SIGTERM');
        return false;
      }
      await sleep(100);
    }
    log(`mediamtx serving rtsp :${options.rtspPort}, hls :${options.hlsPort}, webrtc :${options.webrtcPort}`);
    changed();
    return true;
  }

  async function ensureEncoder() {
    if (encoder) return;
    const screen = await currentDisplay();
    if (!screen) {
      reason = 'no display is serving; start the game';
      return;
    }
    // The sign-in screen stays private: nothing typed there should reach an unauthenticated stream.
    if ((await gameStatus()).phase === 'login_required') {
      reason = 'client is on the sign-in screen';
      return;
    }
    codec ??= chooseEncoder(ffmpeg);
    const out = openSync(paths.encoderLog, 'a');
    const child = spawn(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'warning',
        '-nostdin',
        '-f',
        'x11grab',
        '-framerate',
        String(fps),
        '-video_size',
        `${screen.width}x${screen.height}`,
        '-draw_mouse',
        '0',
        '-i',
        screen.display,
        ...encoderArgs(codec, fps, kbps),
        '-f',
        'rtsp',
        '-rtsp_transport',
        'tcp',
        `rtsp://127.0.0.1:${options.rtspPort}/${options.name}`,
      ],
      { cwd: dir, stdio: ['ignore', out, out], env: { ...process.env, DISPLAY: screen.display } },
    );
    child.once('exit', code => {
      if (encoder === child) {
        encoder = null;
        reason = `ffmpeg exited (${code}); see ${paths.encoderLog}`;
        log(reason);
        changed();
      }
    });
    encoder = child;
    display = screen.display;
    reason = null;
    log(`ffmpeg streaming ${screen.display} at ${screen.width}x${screen.height} ${fps} fps via ${codec}`);
    changed();
  }

  async function tick() {
    if (stopping || missing) return;
    try {
      if (await ensureServer()) await ensureEncoder();
    } catch (error) {
      reason = error.message;
      log(reason);
    }
  }

  mkdirSync(dir, { recursive: true });
  if (missing) log(missing);
  const timer = setInterval(tick, 3000);
  tick();

  async function stop() {
    stopping = true;
    clearInterval(timer);
    const children = [encoder, server].filter(Boolean);
    encoder = null;
    server = null;
    for (const child of children) child.kill('SIGTERM');
    const deadline = Date.now() + 5000;
    while (children.some(child => child.exitCode === null && child.signalCode === null) && Date.now() < deadline) await sleep(100);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }

  return { status, stop };
}
