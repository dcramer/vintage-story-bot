import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameArguments, loadLaunchConfig, updateCharacterName } from '../src/operator/launch-config.ts';

// Run on the OS hosting the bot's game client, e.g. Windows Node for a Windows game.
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const wsl = args.includes('--wsl');
const positional = args.filter(arg => arg !== '--dry-run' && arg !== '--wsl');
const target: Record<string, string> = {};
if (positional.length === 3 && positional[1] === '--world' && positional[2]) target.world = positional[2];
else if (positional.length === 2 && !positional[1].startsWith('-') && positional[1]) target.server = positional[1];
else if (positional.length !== 1 || positional[0].startsWith('--')) {
  console.error('Usage: node scripts/launch-bot.mjs <game-install-directory> [--dry-run] [server:port | --world save-basename]');
  process.exit(1);
}

const gameDirectory = path.resolve(positional[0]);
const windows = process.platform === 'win32';
const executable = path.join(gameDirectory, windows ? 'Vintagestory.exe' : 'Vintagestory.dll');
const dataRoot = windows ? process.env.APPDATA : process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
if (!dataRoot) {
  console.error('APPDATA is missing; run this from a regular Windows terminal.');
  process.exit(1);
}
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const botData = wsl ? path.join(repository, '.runtime', 'bot-data') : path.resolve(dataRoot, 'VintagestoryAI');
let config;
try {
  config = loadLaunchConfig(repository, botData, target);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
// The mod loader scans each child directory for its modinfo.json and assembly.
const modRoot = wsl ? path.join(botData, 'Mods') : path.join(repository, 'mod', 'bin', 'Release');
const modDirectory = path.join(modRoot, wsl ? 'VintageStoryAI' : 'net10.0');
for (const required of [executable, path.join(modDirectory, 'VintageStoryAI.dll'), path.join(modDirectory, 'modinfo.json')]) {
  if (!existsSync(required)) {
    console.error(`Missing ${required}. Check the game path and build the mod first.`);
    process.exit(1);
  }
}
const dotnet = wsl ? path.join(repository, '.dotnet', 'dotnet') : 'dotnet';
const command = windows ? executable : dotnet;
const gameArgs = [...(windows ? [] : [executable]), ...gameArguments(config, botData, { modRoot: wsl ? '' : modRoot, redact: dryRun })];
console.log(`Bot profile: ${botData}`);
console.log('Sign in with the bot account if needed; the bridge listens once a world is loaded.');
if (dryRun) {
  console.log(JSON.stringify({ command, args: gameArgs, cwd: gameDirectory }, null, 2));
} else {
  try {
    updateCharacterName(botData, config.characterName);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const child = spawn(command, gameArgs, {
    cwd: gameDirectory,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, VINTAGE_STORY_SERVER_PASSWORD: '' },
  });
  child.on('error', error => {
    console.error(`Cannot launch bot client: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
