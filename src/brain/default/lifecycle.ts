// The checks that run before any thinking: rest, death, an empty health bar,
// blocked controls, the one look around after startup, and wet or unsteady
// footing. Each returns the decision when the body cannot do useful work yet,
// or null to carry on. Called from decide() in the same order as before.
import type { Decision, Reading } from '../../runtime/brain.ts';
import { temporalStormUnsafe } from '../../support/fieldwork.ts';
import { ownedSlots } from '../../support/inventory.ts';
import type { Concern, Context, Job, Memory } from './concern.ts';
import { workOn } from './concern.ts';
import type { BrainState } from './reading.ts';
import { recoverBurrow } from './reflexes/burrow.ts';
import { forgetOldScares } from './reflexes/relocate.ts';
import { surfacing } from './reflexes/swim.ts';

const carriedNow = (inventory: any): Record<string, number> => {
  const snapshot: Record<string, number> = {};
  for (const slot of ownedSlots(inventory)) if (slot.code && slot.quantity > 0) snapshot[slot.code] = (snapshot[slot.code] ?? 0) + slot.quantity;
  return snapshot;
};

// Goals can consume one or two items between the brain's last live reading and
// the death event. Both the distinct item kinds and most units must survive,
// which distinguishes a keep-inventory respawn from an empty spawn without
// requiring access to the server's private world configuration.
export function retainedInventory(before: Record<string, number>, after: Record<string, number>): boolean {
  const entries = Object.entries(before).filter(([, quantity]) => quantity > 0);
  if (entries.length < 2) return false;
  const codes = entries.filter(([code]) => (after[code] ?? 0) > 0).length;
  const units = entries.reduce((total, [code, quantity]) => total + Math.min(quantity, after[code] ?? 0), 0);
  const total = entries.reduce((sum, [, quantity]) => sum + quantity, 0);
  return codes / entries.length >= 0.8 && units / total >= 0.8;
}

// A dialog left open by a goal that failed (a recipe selector, the handbook, a container) blocks every control;
// a player presses Escape. Character creation, death and disconnection are not closed this way.
// Escape is pressed at most a few times in a short while, then the wait says what is open.
export const DIALOG_CLOSES = 3;
export const DIALOG_CLOSE_MS = 10000;
export const closableDialog = (dialogs: Reading['dialogs']) =>
  dialogs?.find(d => d.blocksControl && /^GuiDialog(?!CreateCharacter|Dead|Death|Disconnect|Confirm|Login)/.test(d.name))?.name ?? null;

// Rest, death, health, controls, startup: nothing here needs to know what job is picked.
export function earlyDecision(reading: Reading, memory: Memory): Decision | null {
  const { inventory, active, now } = reading;
  const state = reading.state as BrainState;
  if (memory.resting) return { wait: 'resting after too many scares' };
  forgetOldScares(memory, now);
  // Dead: respawn when the server offers it; nothing else matters until then.
  // A respawn moves the character independently of the place it died. Forget
  // transient terrain state so the next live reading inspects the new spawn
  // instead of treating it as the old burrow or pit.
  if (!state.alive) {
    if (state.life?.deathId && !memory.deathInventory && Object.keys(memory.lastInventory).length > 0)
      memory.deathInventory = { ...memory.lastInventory };
    memory.burrow = null;
    memory.pit = null;
    memory.pitJob = null;
    memory.startupChecked = false;
    memory.startupAt = null;
    memory.pendingHurtAt = null;
    if (active) return { stop: 'dead' };
    if (temporalStormUnsafe(state)) return { wait: 'dead, waiting out temporal storm' };
    return state.life?.deathId && state.life?.canRespawn
      ? { act: [{ action: 'respawn', deathId: state.life.deathId }], why: 'dead' }
      : { wait: 'dead, waiting for respawn' };
  }
  const carried = carriedNow(inventory);
  if (memory.deathInventory) {
    if (retainedInventory(memory.deathInventory, carried)) {
      memory.notes.keepInventory = true;
      memory.notes.recovery = null;
    }
    memory.deathInventory = null;
  }
  memory.lastInventory = carried;
  // Death during multiplayer join can arrive before the client's Alive flag
  // and dialog synchronize. Do not perform ghost actions or invent a respawn
  // request; wait for the native life state to agree with the empty health bar.
  if (state.vitals?.health?.current === 0)
    return active ? { stop: 'zero health; waiting for life state to synchronize' } : { wait: 'zero health; waiting for life state to synchronize' };
  // A world still loading, a menu or a dialog: no goal can begin, and one refused
  // before it began would only be started again at once. Wait for the controls.
  if (state.controlReady === false) {
    // A running goal's own dialog (a container open for a transfer, a recipe selector) is its to close.
    const closable = active ? null : closableDialog(reading.dialogs);
    memory.dialogCloses = memory.dialogCloses.filter(at => now - at < DIALOG_CLOSE_MS);
    if (closable && memory.dialogCloses.length < DIALOG_CLOSES) {
      memory.dialogCloses.push(now);
      return { act: [{ action: 'close_dialog' }], why: `${closable} blocks the controls` };
    }
    return { wait: 'controls not ready (loading, menu or dialog)' };
  }
  return recoverBurrow(reading, memory);
}

// Wet footing cannot gather, craft or dig. A flight stopped mid-jump needs a
// tick to land before fieldwork goals will start. A hole comes before any job.
export function readyDecision(ctx: Context, lookup: (job: Job) => Concern): Decision | null {
  const { state, reading, memory } = ctx;
  if (state.motion?.swimming || state.motion?.feetInLiquid) return surfacing(state, reading.ground);
  // Stopping a flight can catch the body between a jump and its landing. Every
  // fieldwork goal requires grounded footing, so let physics settle instead of
  // immediately failing the resumed kit job and setting it aside for minutes.
  if (state.motion?.onGround === false) return { wait: 'settling after movement' };
  if (memory.pit) {
    memory.job = 'dig_out';
    return workOn('dig_out', ctx, lookup);
  }
  return null;
}
