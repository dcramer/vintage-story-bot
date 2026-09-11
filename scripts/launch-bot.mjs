import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Run on the OS hosting the bot's game client, e.g. Windows Node for a Windows game.
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const positional = args.filter((arg) => arg !== '--dry-run');
if (positional.length !== 1 || args.some((arg) => arg.startsWith('--') && arg !== '--dry-run')) {
  console.error('Usage: node scripts/launch-bot.mjs <game-install-directory> [--dry-run]');
  process.exit(1);
}

const gameDirectory = path.resolve(positional[0]);
const windows = process.platform === 'win32';
const executable = path.join(gameDirectory, windows ? 'Vintagestory.exe' : 'Vintagestory.dll');
const dataRoot = windows ? process.env.APPDATA : (process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'));
if (!dataRoot) {
  console.error('APPDATA is missing; run this from a regular Windows terminal.');
  process.exit(1);
}
const botData = path.resolve(dataRoot, 'VintagestoryAI');
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The mod loader scans each child directory for its modinfo.json and assembly.
const modRoot = path.join(repository, 'mod', 'bin', 'Release');
for (const required of [executable, path.join(modRoot, 'net10.0', 'VintageStoryAI.dll'), path.join(modRoot, 'net10.0', 'modinfo.json')]) {
  if (!existsSync(required)) {
    console.error(`Missing ${required}. Check the game path and build the mod first.`);
    process.exit(1);
  }
}
const command = windows ? executable : 'dotnet';
const gameArgs = [
  ...(windows ? [] : [executable]),
  `--dataPath=${botData}`,
  `--addModPath=${modRoot}`,
];
console.log(`Bot profile: ${botData}`);
console.log('Sign in with the bot account, join your server, then enter .aibridge on.');
if (dryRun) {
  console.log(JSON.stringify({ command, args: gameArgs, cwd: gameDirectory }, null, 2));
} else {
  const child = spawn(command, gameArgs, { cwd: gameDirectory, stdio: 'inherit', shell: false });
  child.on('error', (error) => {
    console.error(`Cannot launch bot client: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
