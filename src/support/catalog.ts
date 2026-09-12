import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The handbook catalog on disk (docs/catalog.json, dumped by scripts/catalog.ts):
// every block, item and creature of the game version, as facts. Read once,
// lazily; absent when never dumped, and then only pages read in play are known.
export const catalogPath = join(dirname(fileURLToPath(import.meta.url)), '../../docs/catalog.json');
let loaded: { generatedFrom: string; entries: any[]; byCode: Map<string, any> } | null | undefined;
export function catalog() {
  if (loaded === undefined) {
    try {
      const data = JSON.parse(readFileSync(catalogPath, 'utf8'));
      loaded = { generatedFrom: data.generatedFrom, entries: data.entries, byCode: new Map(data.entries.map(entry => [entry.code, entry])) };
    } catch {
      loaded = null;
    }
  }
  return loaded;
}
export const catalogEntry = code => (code ? (catalog()?.byCode.get(code) ?? null) : null);
