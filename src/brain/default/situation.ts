// What the default brain reads off one Reading: the kit in plain counts, the
// Situation the ladder decides on, and the danger sense (a threat in view or
// just out of it, a hit and what explains it). Pure functions over readings.
import type { Reading } from '../../runtime/brain.ts';
import { foodReserve } from '../../support/food.ts';
import { kinds } from '../../support/forming.ts';
import { ownedSlots } from '../../support/inventory.ts';
import { nearestThreat } from '../../support/threats.ts';
import type { Cell, Memory } from './concern.ts';

// Night from dusk (the sun's light under 0.4, when drifters come out and the eye
// sees little) to dawn; unknown light counts as day, since
// without a reading the brain cannot call itself home.
export const NIGHT_LIGHT = 0.4;
export const isNight = (environment: any) => typeof environment?.calendar?.daylight === 'number' && environment.calendar.daylight < NIGHT_LIGHT;
// The stones that knap, as the game names them.
export const KNAPPABLE = ['chert', 'granite', 'andesite', 'basalt', 'obsidian', 'peridotite'];
// A threat seen this recently is still a threat once out of view; a flight ends when nothing has shown for this long and the scare is this far behind.
export const SAFE_MS = 20000;
export const SAFE_DISTANCE = 16;
// Hurt arrives before the server notification that identifies its cause. Give
// gravity a fraction of a second to identify itself before abandoning useful work.
export const HURT_CLASSIFY_MS = 750;

// The knappable material carried, as the game names tool heads after it: flint, or a rock type.
export function knapMaterial(slots: any[]): string | null {
  const stone = slots.find(s => s.code && kinds.knapping.materials(s));
  if (!stone) return null;
  return stone.code === 'game:flint' ? 'flint' : (stone.code.match(/^game:stone-([a-z]+)$/)?.[1] ?? null);
}
// What the bot carries, in plain counts.
export function kit(inventory: any) {
  const slots = ownedSlots(inventory) as any[];
  const exact = (code: string) => slots.filter(s => s.code === code).reduce((n, s) => n + s.quantity, 0);
  const part = (piece: string) => slots.filter(s => s.code?.includes(piece)).reduce((n, s) => n + s.quantity, 0);
  const tool = (name: string) => slots.some(s => s.tool === name && (s.durability ?? 1) > 0);
  return {
    sticks: exact('game:stick'),
    knife: tool('Knife'),
    axe: tool('Axe'),
    shovel: tool('Shovel'),
    // Tool heads of any knappable material; the material carried names the head to knap and the tool to haft.
    shovelBlade: part('game:shovelhead-'),
    knifeBlade: part('game:knifeblade-'),
    axeBlade: part('game:axehead-'),
    material: knapMaterial(slots),
    heads: slots.map(s => s.code).filter(code => /^game:(knifeblade|axehead|shovelhead)-/.test(code ?? '')) as string[],
    torches: part('torch-basic'),
    torch: slots.find(s => s.code?.includes('torch-basic'))?.code ?? null,
    dirt: part('soil-'),
    dirtCode: slots.find(s => s.code?.includes('soil-'))?.code ?? null,
    stone: slots.some(s => s.code && kinds.knapping.materials(s)),
    grass: part('drygrass') + part('cattailtops'),
    logs: part('log-'),
    reserve: foodReserve(inventory) as number,
  };
}
export type Kit = ReturnType<typeof kit>;
// The material of a carried tool head, from its code (game:knifeblade-flint -> flint).
export function headMaterial(k: Kit, head: string): string {
  return k.heads.find(code => code.startsWith(`game:${head}-`))?.slice(`game:${head}-`.length) ?? k.material ?? 'flint';
}

export type Situation = {
  threat: boolean;
  hurt: boolean;
  storm: boolean;
  hunger: number | null;
  reserve: number;
  night: boolean;
  home: boolean;
  atHome: boolean;
  burrowed: boolean;
  dangerHere: boolean;
  // A death marker is on the map: the body's things lie there.
  body: boolean;
  sticks: number;
  knife: boolean;
  axe: boolean;
  shovel: boolean;
  stone: boolean;
  torches: number;
  grass: number;
  dirt: number;
  logs: number;
};

export const environmentalHurt = (events: any[]) =>
  events.some(event => event.type === 'message' && /^Lost [\d.]+ hp through gravity$/i.test(event.text ?? ''));
export type Danger = { point: Cell; code: string };
// A threat in view or remembered from the cancellation just completed, and whether a hit
// was an attack: a hit with no attacker in sight is still danger unless something
// explains it (gravity, or what the running job did to itself), and an unexplained hit
// waits a moment for the cause notification before it counts.
export function senseDanger(reading: Reading, memory: Memory, explainedByJob: boolean) {
  const { state, last, now, events = [] } = reading;
  const threat = nearestThreat(state);
  if (threat) memory.lastThreat = { point: threat.point, code: threat.code, at: now };
  // A predator can leave the observation radius while its cancellation is
  // completing. Carry that exact threat through the next decision so the
  // cancelled job becomes a flight instead of immediately restarting work.
  const rememberedThreat =
    last?.reason === 'brain: threat' && memory.lastThreat && now - memory.lastThreat.at < SAFE_MS
      ? { point: memory.lastThreat.point, code: memory.lastThreat.code }
      : null;
  const danger: Danger | null = threat ?? rememberedThreat;
  // The server advances lastDamageAt for falls too; the notification identifies gravity.
  // The event cursor advances when the running goal is stopped. Carry the
  // stop reason into this decision so a one-tick hit actually starts a flight
  // instead of cancelling work and immediately restarting the same job.
  const explainedHurt = environmentalHurt(events) || explainedByJob;
  // Max-health nutrition drift can lower current and maximum health together.
  // The bridge reports that as a hurt event even though the bar remains full;
  // only a real deficit is evidence of damage from something unseen.
  const health = state.vitals?.health,
    fullHealth = Number.isFinite(health?.current) && Number.isFinite(health?.max) && health.current >= health.max - 0.01,
    rawHurt = !fullHealth && events.some(e => e.type === 'hurt');
  if (explainedHurt || danger) memory.pendingHurtAt = null;
  else if (rawHurt && memory.pendingHurtAt === null) memory.pendingHurtAt = now;
  const pendingHurt = memory.pendingHurtAt !== null && now - memory.pendingHurtAt >= HURT_CLASSIFY_MS;
  // A known nearby threat removes the need to wait for a cause notification.
  // This matters inside a burrow: merely hearing a creature outside is safe,
  // but losing health while it is nearby proves the pocket is compromised.
  const hurt = !explainedHurt && (last?.reason === 'brain: hurt' || pendingHurt || (rawHurt && !!danger));
  const classifyingHurt = !explainedHurt && !danger && memory.pendingHurtAt !== null && !pendingHurt;
  if (pendingHurt) memory.pendingHurtAt = null;
  return { danger, hurt, classifyingHurt };
}
