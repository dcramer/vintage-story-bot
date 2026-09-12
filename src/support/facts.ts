import { catalogEntry } from './catalog.ts';

// What the bot has read about kinds of things, by code: the handbook catalog
// of the game version, plus pages read in play (item_info) for codes the
// catalog lacks, kept for the life of the controller. Reading a page is one
// player act; which pages to read follows from what the eye has seen.
// Nothing here decides anything and nothing here comes from the world.
const pages = new Map();

export const known = code => pages.get(code) ?? catalogEntry(code) ?? null;
export const remember = (code, page) => {
  pages.set(code, page);
  return page;
};

export async function learn(field, code) {
  if (!code) return null;
  const page = known(code);
  if (page || pages.has(code)) return page;
  const read = await field.send({ action: 'item_info', code });
  return remember(code, read?.ok ? read : null);
}

// Read a block's page and the pages of what it yields, so the yield can be judged.
export async function learnYields(field, codes) {
  for (const code of new Set(codes)) {
    const page = await learn(field, code);
    for (const drop of [...(page?.harvest?.drops ?? []), ...(page?.drops ?? [])].slice(0, 8)) await learn(field, drop.code);
  }
}
