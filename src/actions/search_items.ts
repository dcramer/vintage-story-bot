import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';
import { catalog } from '../support/catalog.ts';
import { traitsOfPage } from '../support/traits.ts';

export const schema = z
  .object({
    match: z.string().min(1).max(64).optional().describe('Name or code substring; omit to search by trait alone.'),
    trait: z.string().min(1).max(32).optional().describe('Keep only entries with this trait, e.g. edible, fuel, harvestable, tool:Axe.'),
    type: z.enum(['block', 'item', 'entity']).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict()
  .refine(value => value.match || value.trait, { message: 'Give match or trait' });

function rank(entry, needle) {
  const code = entry.code.toLowerCase(),
    name = (entry.name ?? '').toLowerCase();
  if (code === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.includes(needle)) return 2;
  return 3;
}

export default defineAction({
  name: 'search_items',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'Search the handbook catalog by name or code substring and/or trait: every block, item and creature with its ' +
    "description, the game's typing (class, material, behaviors), food/tool/fuel facts, drops, harvest, the recipes that " +
    'make it, and its traits (what it affords). Static per game version (regenerate after a game update). Full page text ' +
    'via item_info; grid crafting with owned-stack matches via recipes.',
  local: async (_runtime, { match, trait, type, limit = 8 }) => {
    const data = catalog();
    if (!data) return { ok: false, error: 'Catalog missing; regenerate with node scripts/catalog.ts against a loaded world.' };
    const needle = match?.toLowerCase() ?? '';
    const hits = data.entries
      .filter(
        entry =>
          (!type || entry.type === type) &&
          (!needle || entry.code.toLowerCase().includes(needle) || (entry.name ?? '').toLowerCase().includes(needle)),
      )
      .map(entry => ({ ...entry, traits: traitsOfPage(entry) }))
      .filter(entry => !trait || entry.traits.includes(trait));
    hits.sort((a, b) => rank(a, needle) - rank(b, needle) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    return { ok: true, generatedFrom: data.generatedFrom, total: hits.length, more: hits.length > limit, items: hits.slice(0, limit) };
  },
});
