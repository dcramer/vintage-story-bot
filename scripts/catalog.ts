#!/usr/bin/env node
// Dump the handbook catalog (every loaded block/item: name, description, food/tool/fuel
// facts, drops, harvest, plus the recipes that make it) into docs/catalog.json.
//   node scripts/catalog.ts
// Requires the game with a loaded world (pnpm game start); talks to the mod bridge
// directly like other operator scripts. Regenerate after a game update, never edit by hand.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestBridge } from '../src/runtime/bridge.ts';

const root = process.cwd();

// recipes.json output patterns use * wildcards and {variable} single-segment substitutions.
export const toRegExp = pattern =>
  new RegExp(
    '^' +
      pattern
        .split(/(\*|\{[^}]+\})/)
        .map(part => (part === '*' ? '.*' : /^\{[^}]+\}$/.test(part) ? '[^-]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('') +
      '$',
  );

const recipes = JSON.parse(readFileSync(join(root, 'docs/recipes.json'), 'utf8')).recipes;
const concrete = new Map();
const patterns = [];
for (const recipe of recipes) {
  const output = recipe.output?.code;
  if (!output) continue;
  if (output.includes('*') || output.includes('{')) patterns.push({ regex: toRegExp(output), recipe });
  else {
    if (!concrete.has(output)) concrete.set(output, []);
    concrete.get(output).push(recipe);
  }
}
// Every recipe that makes this exact code.
const makes = code => {
  const found = [...(concrete.get(code) ?? [])];
  for (const { regex, recipe } of patterns) if (regex.test(code)) found.push(recipe);
  return found.slice(0, 16);
};

const entries = [];
let offset = 0,
  total = Infinity;
for (;;) {
  const page = await requestBridge({ action: 'catalog', offset, limit: 50 }, { timeoutMs: 15000 });
  if (!page.ok) throw new Error(`Catalog dump failed at offset ${offset}: ${page.error ?? 'unknown'}`);
  total = page.total;
  for (const entry of page.entries) entries.push({ ...entry, recipes: makes(entry.code) });
  offset += page.entries.length;
  process.stderr.write(`\r${offset}/${total}`);
  if (!page.more || page.entries.length === 0) break;
}
process.stderr.write('\n');

const versionFile = readdirSync(join(root, '.runtime/linux-client/assets')).find(name => name.startsWith('version-'));
const version = versionFile ? versionFile.slice('version-'.length, -'.txt'.length) : 'unknown';
const kinds: Record<string, number> = {};
for (const entry of entries) kinds[entry.type] = (kinds[entry.type] ?? 0) + 1;
const withRecipes = entries.filter(entry => entry.recipes.length > 0).length;
const out = join(root, 'docs/catalog.json');
writeFileSync(
  out,
  JSON.stringify(
    {
      generatedFrom: `game ${version} handbook (${entries.length} collectibles), recipes joined from docs/recipes.json`,
      entries,
    },
    null,
    0,
  ) + '\n',
);
console.log(`${entries.length} entries (${kinds.item ?? 0} items, ${kinds.block ?? 0} blocks; ${withRecipes} with recipes) → docs/catalog.json`);
