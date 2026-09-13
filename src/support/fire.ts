import { useOnBlock } from '../goals/use_block.ts';
import { parseBlockKey, selectCell } from './blocks.ts';

// A firestarter has a native chance to catch. Try again only after observing
// the same unlit block and no item consumption; a changed target ends work.
export async function ignite(field, { target, lit, holdMs }) {
  const cell = parseBlockKey(target);
  while (true) {
    const selected = await selectCell(field, cell);
    if (selected?.code?.includes(lit)) return { ok: true, target: selected.key, verification: 'client_observed' };
    if (selected?.key !== target) return { ok: false, reason: 'ignition_target_changed', target };
    const result = await useOnBlock(field, { target, item: 'game:firestarter', sneak: true, holdMs, expectAfter: lit });
    if (result.ok || result.reason !== 'no_observed_effect' || result.consumed > 0) return result;
  }
}
