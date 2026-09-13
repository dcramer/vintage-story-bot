import type { Decision } from '../../runtime/brain.ts';
import type { Concern, Context } from './concern.ts';
import { failedOnItsOwn } from './concern.ts';

// Food recovery is intentionally renewable-only. In particular, cattail roots
// are not a fallback: taking one removes the plant and repeated recovery runs
// can strip a wetland bare. The generic cook goal remains available to an
// operator, but the default brain does not acquire, cook, or recover roots.
export function food(ctx: Context, keep: number): Decision {
  const { k } = ctx;
  if (k.free < 2 && (ctx.s.foodRecovery || (ctx.s.hunger !== null && ctx.s.hunger < 0.2))) {
    const soil = k.slots
      .filter(s => /^game:soil-(low|verylow)-/.test(s.code ?? '') && k.dirt - s.quantity >= 4)
      .sort((a, b) => a.quantity - b.quantity)[0];
    const discard = soil ?? k.slots.find(s => !s.nutrition && /^game:(treeseed-|flower-)/.test(s.code ?? ''));
    if (discard)
      return {
        act: [{ action: 'drop', from: { inventory: discard.inventory, slot: discard.slot }, quantity: discard.quantity, expectedState: k.state }],
        why: 'make room for food while retaining shelter sealing blocks',
      };
  }

  return {
    start: 'forage',
    // Forage owns its evidence-based distance/time bound and returns
    // none_found. A caller deadline discards that result as no_progress.
    args: { until: 0.5, keep },
    why: `${k.reserve} carried; look for renewable edible forage without uprooting cattails`,
  };
}

export const foodEnded: Concern['ended'] = () => {};

// An exhaustive renewable-food search is evidence, not a reason to spend the
// whole day repeating it. Let other work run before the normal retry window.
export const foodSetAside: Concern['setAside'] = last => failedOnItsOwn(last);
