import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';

// --playStyle matches the play style's lang code, not its code (ScreenManager.openWorldFromArgs).
export const playStyles = {
  surviveandbuild: 'preset-surviveandbuild',
  wildernesssurvival: 'preset-wildernesssurvival',
  creativebuilding: 'creativebuilding',
};

function validWorldName(world) {
  return world && !world.startsWith('.') && !/[\\/]/.test(world);
}

// target.create names a world to create; target.world must already exist.
export function loadLaunchConfig(repository, botData, target: any = {}) {
  const envFile = path.join(repository, '.env');
  if (existsSync(envFile)) loadEnvFile(envFile);
  const create = target.create ?? '';
  if ([create, target.world, target.server].filter(Boolean).length > 1) throw new Error('Choose one of --new, --world or --server.');
  if (target.playStyle && !create) throw new Error('--play-style applies only with --new.');
  const world = create || target.world || (target.server ? '' : process.env.VINTAGE_STORY_WORLD || '');
  const server = world ? '' : (target.server ?? process.env.VINTAGE_STORY_SERVER ?? '');
  if (create && (!validWorldName(create) || existsSync(path.join(botData, 'Saves', `${create}.vcdbs`)))) {
    throw new Error('--new must name a save that does not exist yet, without .vcdbs.');
  }
  if (create && target.playStyle && !Object.hasOwn(playStyles, target.playStyle)) {
    throw new Error(`--play-style must be one of ${Object.keys(playStyles).join(', ')}.`);
  }
  if (!create && world && (!validWorldName(world) || !existsSync(path.join(botData, 'Saves', `${world}.vcdbs`)))) {
    throw new Error('VINTAGE_STORY_WORLD / --world must name an existing bot save without .vcdbs.');
  }
  if (server && (server.startsWith('-') || /[\s/]/.test(server))) {
    throw new Error('VINTAGE_STORY_SERVER must be a host or host:port.');
  }
  return {
    world,
    playStyle: create ? playStyles[target.playStyle || 'surviveandbuild'] : '',
    server,
    characterName: process.env.VINTAGE_STORY_CHARACTER_NAME || '',
    password: server ? process.env.VINTAGE_STORY_SERVER_PASSWORD || '' : '',
  };
}

// Game process arguments after the executable. Redact keeps the password out of dry-run output.
export function gameArguments(config, botData, { modRoot = '', redact = false } = {}) {
  return [
    `--dataPath=${botData}`,
    ...(modRoot ? [`--addModPath=${modRoot}`] : []),
    ...(config.world ? [`--openWorld=${config.world}`] : []),
    ...(config.playStyle ? [`--playStyle=${config.playStyle}`] : []),
    ...(config.server ? [`--connect=${config.server}`] : []),
    ...(config.password ? [`--pw=${redact ? '[redacted]' : config.password}`] : []),
  ];
}

function readSettings(botData) {
  const settingsPath = path.join(botData, 'clientsettings.json');
  if (!existsSync(settingsPath)) return null;
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (!settings?.stringSettings || typeof settings.stringSettings !== 'object' || Array.isArray(settings.stringSettings)) throw new Error();
  } catch {
    throw new Error('Cannot parse the bot clientsettings.json.');
  }
  return { settingsPath, settings };
}

function writeSettings({ settingsPath, settings }) {
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

export function updateCharacterName(botData, characterName) {
  if (!characterName) return;
  const file = readSettings(botData);
  if (!file) throw new Error('Sign in with the bot account once before configuring VINTAGE_STORY_CHARACTER_NAME.');
  file.settings.stringSettings.playername = characterName;
  writeSettings(file);
}

export function presentationConfig() {
  const number = (name, fallback, min, max, integer = false) => {
    const value = Number(process.env[name] || fallback);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
    }
    return value;
  };
  const camera = process.env.VINTAGE_STORY_CAMERA || 'thirdperson';
  if (!['firstperson', 'thirdperson', 'overhead'].includes(camera)) {
    throw new Error('VINTAGE_STORY_CAMERA must be firstperson, thirdperson or overhead.');
  }
  return {
    camera,
    distance: number('VINTAGE_STORY_CAMERA_DISTANCE', 3, 1, 10),
    fov: number('VINTAGE_STORY_FOV', 70, 30, 120, true),
    guiScale: number('VINTAGE_STORY_UI_SCALE', 1, 0.5, 2),
  };
}

// Windowed at the virtual screen size so the borderless headless window fills the display exactly.
// The mod answers on the game tick, which runs once per rendered frame, so the frame cap is also
// the cap on how fast the bot can sense and act: never below 60.
export function updateWindowSettings(botData, { width, height }, presentation = presentationConfig()) {
  const file = readSettings(botData);
  if (!file) return false;
  const ints = (file.settings.intSettings ??= {});
  const floats = (file.settings.floatSettings ??= {});
  const maxFps = Math.max(Number(ints.maxFps) || 0, 60);
  if (
    ints.screenWidth === width &&
    ints.screenHeight === height &&
    ints.gameWindowMode === 0 &&
    ints.maxFps === maxFps &&
    ints.fieldOfView === presentation.fov &&
    floats.guiScale === presentation.guiScale
  )
    return false;
  Object.assign(ints, { screenWidth: width, screenHeight: height, gameWindowMode: 0, maxFps, fieldOfView: presentation.fov });
  floats.guiScale = presentation.guiScale;
  writeSettings(file);
  return true;
}
