#!/usr/bin/env node
// What the catalog's kinds afford, and what is left unmapped: every trait with
// its count, then every class, material and behavior none of whose entries carry
// a trait beyond the typing itself, so a new kind of thing is noticed rather
// than silently ignored.
//   node scripts/traits.ts [--unmapped]
import { catalog } from '../src/support/catalog.ts';
import { TRAITS, traitsOfPage } from '../src/support/traits.ts';

const data = catalog();
if (!data) {
  console.error('Catalog missing; dump it with node scripts/catalog.ts against a loaded world.');
  process.exit(1);
}
const counts = new Map<string, number>();
const groups = { class: new Map<string, { entries: number; mapped: number; example: string }>(), material: new Map(), behavior: new Map() };
const tally = (group, key, mapped, code) => {
  if (!key) return;
  const row = group.get(key) ?? { entries: 0, mapped: 0, example: code };
  row.entries++;
  if (mapped) row.mapped++;
  group.set(key, row);
};
let mapped = 0;
for (const entry of data.entries) {
  const traits = traitsOfPage(entry);
  for (const trait of traits) counts.set(trait, (counts.get(trait) ?? 0) + 1);
  const useful = traits.some(trait => !['plant', 'leaves', 'creature', 'placeable'].includes(trait));
  if (useful) mapped++;
  tally(groups.class, entry.class, useful, entry.code);
  tally(groups.material, entry.material, useful, entry.code);
  for (const behavior of entry.behaviors ?? []) tally(groups.behavior, behavior, useful, entry.code);
}
console.log(`${data.generatedFrom}: ${mapped}/${data.entries.length} entries carry a trait that says what to do with them`);
for (const [trait, count] of [...counts].sort((a, b) => b[1] - a[1]))
  console.log(`${String(count).padStart(6)}  ${trait.padEnd(14)} ${TRAITS[trait] ?? TRAITS[trait.split(':')[0]] ?? ''}`);
for (const [name, group] of Object.entries(groups)) {
  const unmapped = [...group].filter(([, row]) => row.mapped === 0).sort((a, b) => b[1].entries - a[1].entries);
  if (!unmapped.length) continue;
  console.log(`\n${name}: ${unmapped.length} of ${group.size} with no trait to act on`);
  for (const [key, row] of unmapped.slice(0, process.argv.includes('--unmapped') ? 1000 : 25))
    console.log(`${String(row.entries).padStart(6)}  ${key.padEnd(40)} e.g. ${row.example}`);
}
