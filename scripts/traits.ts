#!/usr/bin/env node
// What the game's kinds afford, and what is left unmapped: every trait with
// its count, then every class, material and behavior none of whose kinds carry
// a trait beyond the typing itself, so a new kind of thing is noticed rather
// than silently ignored. Reads the handbook index from the loaded game, facts
// only (no page text), a page at a time; a development report, never the bot.
//   node scripts/traits.ts [--unmapped]
import { requestBridge } from '../src/runtime/bridge.ts';
import { remember } from '../src/support/facts.ts';
import { TRAITS, traitsOfPage } from '../src/support/traits.ts';

const counts = new Map<string, number>();
const groups = { class: new Map<string, { entries: number; mapped: number; example: string }>(), material: new Map(), behavior: new Map() };
const tally = (group, key, mapped, code) => {
  if (!key) return;
  const row = group.get(key) ?? { entries: 0, mapped: 0, example: code };
  row.entries++;
  if (mapped) row.mapped++;
  group.set(key, row);
};
let mapped = 0,
  total = 0,
  seen = 0;
for (let offset = 0; ; ) {
  const page = await requestBridge({ action: 'catalog', offset, limit: 100 }, { timeoutMs: 15000, maxBytes: 4 * 1024 * 1024 });
  if (!page.ok) throw new Error(page.error ?? 'catalog refused');
  total = page.total;
  for (const entry of page.entries) {
    remember(entry.code, entry);
    const traits = traitsOfPage(entry);
    for (const trait of traits) counts.set(trait, (counts.get(trait) ?? 0) + 1);
    const useful = traits.some(trait => !['plant', 'leaves', 'creature', 'placeable'].includes(trait));
    if (useful) mapped++;
    tally(groups.class, entry.class, useful, entry.code);
    tally(groups.material, entry.material, useful, entry.code);
    for (const behavior of entry.behaviors ?? []) tally(groups.behavior, behavior, useful, entry.code);
  }
  seen += page.entries.length;
  offset += page.entries.length;
  process.stderr.write(`\r${seen}/${total}`);
  if (!page.more || !page.entries.length) break;
}
process.stderr.write('\n');
console.log(`${mapped}/${total} kinds carry a trait that says what to do with them`);
for (const [trait, count] of [...counts].sort((a, b) => b[1] - a[1]))
  console.log(`${String(count).padStart(6)}  ${trait.padEnd(14)} ${TRAITS[trait] ?? TRAITS[trait.split(':')[0]] ?? ''}`);
for (const [name, group] of Object.entries(groups)) {
  const unmapped = [...group].filter(([, row]) => row.mapped === 0).sort((a, b) => b[1].entries - a[1].entries);
  if (!unmapped.length) continue;
  console.log(`\n${name}: ${unmapped.length} of ${group.size} with no trait to act on`);
  for (const [key, row] of unmapped.slice(0, process.argv.includes('--unmapped') ? 1000 : 25))
    console.log(`${String(row.entries).padStart(6)}  ${key.padEnd(40)} e.g. ${row.example}`);
}
