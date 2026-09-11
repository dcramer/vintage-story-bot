import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const localTool = `${root}/.runtime/x11/usr/bin/xdotool`;
const localMagick = `${root}/.runtime/x11/usr/lib/x86_64-linux-gnu/ImageMagick-6.9.12`;
const localImport = existsSync(`${root}/.runtime/x11/usr/bin/import`) &&
  existsSync(`${localMagick}/modules-Q16/coders/png.so`);
const env = {
  ...process.env,
  ...(existsSync('/mnt/wslg') ? { DISPLAY: process.env.DISPLAY ?? ':0' } : {}),
  LD_LIBRARY_PATH: `${root}/.runtime/x11/usr/lib/x86_64-linux-gnu${process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''}`,
  ...(localImport ? {
    PATH: `${root}/.runtime/x11/usr/bin${process.env.PATH ? ':' + process.env.PATH : ''}`,
    MAGICK_CONFIGURE_PATH: `${localMagick}/config-Q16`,
    MAGICK_CODER_MODULE_PATH: `${localMagick}/modules-Q16/coders`,
  } : {}),
};

export const uiTools = [
  { name: 'ui_screenshot', schema: z.object({}).strict(), readOnly: true,
    description: 'Capture only the WSL bot window. Works in menus without the bridge. Use before menu input; never capture login secrets.' },
  { name: 'ui_click', schema: z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }).strict(),
    description: 'Left-click bot menu at screenshot pixel coordinates; one targeted click, no retries. Inspect screenshot first. Not for world interaction.' },
  { name: 'ui_key', schema: z.object({ key: z.enum(['Escape', 'Return', 'Tab', 'Up', 'Down', 'Left', 'Right', 'F7', 'F8']) }).strict(),
    description: 'Send a key directly to the bot. Escape opens/closes menu; F7 explicitly enables bridge, F8 disables. No retries.' },
];

async function xdo(args) {
  let command = localTool;
  try { await access(command); } catch { command = 'xdotool'; }
  const result = await exec(command, args, { env, timeout: 3000, maxBuffer: 65536 });
  return result.stdout.trim();
}

export function isBotCommand(argv, repository = root) {
  return argv.includes(`${repository}/.runtime/linux-client/Vintagestory.dll`) &&
    argv.includes(`--dataPath=${repository}/.runtime/bot-data`);
}

export function validateClick({ x, y }, { width, height }) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error('Click outside bot window. Capture a fresh screenshot.');
  }
}

async function botWindow() {
  let ids;
  try { ids = (await xdo(['search', '--onlyvisible', '--name', '^Vintage Story$'])).split(/\s+/); }
  catch { throw new Error('No bot window or xdotool unavailable. Launch scripts/launch-bot-wsl.sh; see docs/runtime.md.'); }
  const matches = [];
  for (const id of ids) {
    if (!/^\d+$/.test(id)) continue;
    try {
      const pid = await xdo(['getwindowpid', id]);
      if (!/^\d+$/.test(pid)) continue;
      const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
      if (isBotCommand(argv)) matches.push(id);
    } catch { /* Window exited during discovery. */ }
  }
  if (matches.length !== 1) throw new Error(`Expected one matching bot window; found ${matches.length}. No input sent.`);
  const id = matches[0];
  const geometry = Object.fromEntries((await xdo(['getwindowgeometry', '--shell', id])).split('\n').map(line => line.split('=')));
  const width = Number(geometry.WIDTH), height = Number(geometry.HEIGHT);
  if (!(width > 0 && height > 0)) throw new Error('Invalid bot window geometry.');
  return { id, width, height };
}

async function focusBot(window) {
  const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  let wsl = false;
  try { await access(powershell); wsl = true; } catch { /* Native Linux. */ }
  if (wsl) {
    const { stdout } = await exec('wslpath', ['-w', `${root}/scripts/focus-bot.ps1`], { timeout: 3000 });
    await exec(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stdout.trim()], { timeout: 5000, maxBuffer: 65536 });
  } else {
    try { await xdo(['windowactivate', '--sync', window.id]); }
    catch { await xdo(['windowfocus', '--sync', window.id]); }
  }
  if (await xdo(['getwindowfocus']) !== window.id) throw new Error('Bot did not retain focus. No click sent.');
}

export async function callUi(name, input) {
  const tool = uiTools.find(tool => tool.name === name);
  if (!tool) throw new Error('Unknown UI tool.');
  const args = tool.schema.parse(input);
  const window = await botWindow();
  if (name === 'ui_screenshot') {
    const { stdout } = await exec('import', ['-window', window.id, 'png:-'], { env, encoding: 'buffer', timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    return { content: [
      { type: 'text', text: JSON.stringify({ width: window.width, height: window.height }) },
      { type: 'image', mimeType: 'image/png', data: stdout.toString('base64') },
    ] };
  }
  if (name === 'ui_click') {
    validateClick(args, window);
    await focusBot(window);
    await xdo(['mousemove', '--window', window.id, String(args.x), String(args.y), 'sleep', '0.15', 'click', '1']);
  } else {
    await xdo(['key', '--window', window.id, args.key]);
  }
  return { content: [{ type: 'text', text: '{"ok":true,"status":"input_sent"}' }] };
}
