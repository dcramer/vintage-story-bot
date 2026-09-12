import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';
import { remember } from '../support/facts.ts';
import { traitsOfPage } from '../support/traits.ts';

export const schema = z
  .object({
    match: z.string().min(1).max(64).describe('Name or code substring, as in the handbook search box.'),
    trait: z.string().min(1).max(32).optional().describe('Keep only entries with this trait, e.g. edible, fuel, harvestable, tool:Axe.'),
    type: z.enum(['block', 'item', 'entity']).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

// recipes.json output patterns use * wildcards and {variable} single-segment substitutions.
const toRegExp = pattern =>
  new RegExp(
    `^${pattern
      .split(/(\*|\{[^}]+\})/)
      .map(part => (part === '*' ? '.*' : /^\{[^}]+\}$/.test(part) ? '[^-]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('')}$`,
  );
let recipes: { concrete: Map<string, any[]>; patterns: { regex: RegExp; recipe: any }[] } | null = null;
// Every grid recipe that makes this exact code, from the recipe dump.
function makes(code: string) {
  if (!recipes) {
    recipes = { concrete: new Map(), patterns: [] };
    try {
      for (const recipe of JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../docs/recipes.json'), 'utf8')).recipes) {
        const output = recipe.output?.code;
        if (!output) continue;
        if (output.includes('*') || output.includes('{')) recipes.patterns.push({ regex: toRegExp(output), recipe });
        else recipes.concrete.set(output, [...(recipes.concrete.get(output) ?? []), recipe]);
      }
    } catch {
      /* no recipe dump: entries carry no recipes */
    }
  }
  const found = [...(recipes.concrete.get(code) ?? [])];
  for (const { regex, recipe } of recipes.patterns) if (regex.test(code)) found.push(recipe);
  return found.slice(0, 16);
}

export default defineAction({
  name: 'search_items',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    "The handbook search box: every block, item and creature whose name or code contains match, with the game's " +
    'typing (class, material, behaviors), food/tool/fuel facts, drops, harvest, the grid recipes that make it, and its ' +
    'traits (what it affords); trait keeps only those. Facts from the mod, no page text: item_info reads the page; ' +
    'recipes matches grid recipes against what is carried.',
  local: async (runtime, { match, trait, type, limit = 8 }) => {
    const items = [];
    let offset = 0,
      total = 0;
    // Pages of 50 from the mod until enough match the trait; a trait filter may read a few pages.
    for (let pages = 0; pages < 8 && items.length < limit + 1; pages++) {
      const page = await runtime.send({ action: 'catalog', match, ...(type ? { type } : {}), offset, limit: 50 });
      if (!page.ok) return page;
      total = page.total;
      for (const entry of page.entries) {
        remember(entry.code, entry);
        const traits = traitsOfPage(entry);
        if (!trait || traits.includes(trait)) items.push({ ...entry, recipes: makes(entry.code), traits });
      }
      offset += page.entries.length;
      if (!page.more) break;
    }
    return { ok: true, total: trait ? undefined : total, more: items.length > limit, items: items.slice(0, limit) };
  },
});
