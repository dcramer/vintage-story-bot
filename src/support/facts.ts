// What the bot has read about kinds of things, by code: handbook pages read
// in play (item_info, facts only, one read per code the eye first sees or the
// pack first holds), kept for the life of the controller. Reading a page is
// one player act; nothing here decides anything and nothing here comes from
// the world.
const pages = new Map();

export const known = code => pages.get(code) ?? null;
export const remember = (code, page) => {
  pages.set(code, page);
  return page;
};
export const learned = code => pages.has(code);

export async function learn(field, code) {
  if (!code) return null;
  if (learned(code)) return known(code);
  const read = await field.send({ action: 'item_info', code, text: false });
  return remember(code, read?.ok ? read : null);
}

// Read a block's page and the pages of what it yields, so the yield can be judged.
export async function learnYields(field, codes) {
  for (const code of new Set(codes)) {
    const page = await learn(field, code);
    for (const drop of [...(page?.harvest?.drops ?? []), ...(page?.drops ?? [])].slice(0, 8)) await learn(field, drop.code);
  }
}
