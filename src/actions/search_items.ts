import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';

export const schema = z.object({
  match: z.string().min(1).max(64),
  type: z.enum(['block', 'item']).optional(),
  limit: z.number().int().min(1).max(20).optional(),
}).strict();

let cached = null;
function catalog() {
  if (!cached) {
    cached = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../docs/catalog.json'), 'utf8'));
  }
  return cached;
}

function rank(entry, needle) {
  const code = entry.code.toLowerCase(), name = (entry.name ?? '').toLowerCase();
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
    'Search the handbook catalog by name or code substring: every block/item with its description, ' +
    'food/tool/fuel facts, drops, harvest and the recipes that make it. Static per game version ' +
    '(regenerate after a game update). Full page text via item_info; grid crafting with owned-stack ' +
    'matches via recipes.',
  local: async (_runtime, { match, type, limit = 8 }) => {
    let data;
    try { data = catalog(); }
    catch {
      return { ok: false, error: 'Catalog missing; regenerate with node scripts/catalog.mjs against a loaded world.' };
    }
    const needle = match.toLowerCase();
    const hits = data.entries.filter(entry =>
      (!type || entry.type === type) &&
      (entry.code.toLowerCase().includes(needle) || (entry.name ?? '').toLowerCase().includes(needle)));
    hits.sort((a, b) => rank(a, needle) - rank(b, needle) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    return { ok: true, generatedFrom: data.generatedFrom, total: hits.length, more: hits.length > limit,
      items: hits.slice(0, limit) };
  },
});
