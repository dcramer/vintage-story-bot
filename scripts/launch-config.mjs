import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';

export function loadLaunchConfig(repository, botData, target = {}) {
  const envFile = path.join(repository, '.env');
  if (existsSync(envFile)) loadEnvFile(envFile);
  const world = target.world ?? (target.server ? '' : process.env.VINTAGE_STORY_WORLD || '');
  const server = world ? '' : target.server ?? process.env.VINTAGE_STORY_SERVER ?? '';
  if (world && (world.startsWith('.') || /[\\/]/.test(world)
    || !existsSync(path.join(botData, 'Saves', `${world}.vcdbs`)))) {
    throw new Error('VINTAGE_STORY_WORLD / --world must name an existing bot save without .vcdbs.');
  }
  if (server && (server.startsWith('-') || /[\s/]/.test(server))) {
    throw new Error('VINTAGE_STORY_SERVER must be a host or host:port.');
  }
  return {
    world,
    server,
    characterName: process.env.VINTAGE_STORY_CHARACTER_NAME || '',
    password: server ? process.env.VINTAGE_STORY_SERVER_PASSWORD || '' : '',
  };
}

export function updateCharacterName(botData, characterName) {
  if (!characterName) return;
  const settingsPath = path.join(botData, 'clientsettings.json');
  if (!existsSync(settingsPath)) {
    throw new Error('Sign in with the bot account once before configuring VINTAGE_STORY_CHARACTER_NAME.');
  }
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (!settings?.stringSettings || typeof settings.stringSettings !== 'object'
      || Array.isArray(settings.stringSettings)) throw new Error();
  } catch {
    throw new Error('Cannot parse the bot clientsettings.json.');
  }
  settings.stringSettings.playername = characterName;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
}
