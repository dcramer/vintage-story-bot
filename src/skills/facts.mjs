// What the bot has read about kinds of things, by code: handbook pages, kept
// for the life of the controller. Reading a page is one player act
// (item_info); which pages to read follows from what the eye has seen.
// Nothing here decides anything and nothing here comes from the world.
const pages = new Map();

export const known = code => pages.get(code) ?? null;
export const remember = (code, page) => { pages.set(code, page); return page; };
export const forget = () => pages.clear();

export async function learn(field, code) {
  if (typeof code !== 'string' || !code) return null;
  if (pages.has(code)) return pages.get(code);
  const page = await field.send({ action: 'item_info', code });
  return remember(code, page?.ok ? page : null);
}

// Read a block's page and the pages of what it yields, so the yield can be judged.
export async function learnYields(field, codes) {
  for (const code of new Set(codes)) {
    const page = await learn(field, code);
    for (const drop of [...(page?.harvest?.drops ?? []), ...(page?.drops ?? [])].slice(0, 8)) await learn(field, drop.code);
  }
}
