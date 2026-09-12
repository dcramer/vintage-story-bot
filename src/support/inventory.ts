export const ownedSlots = inventory =>
  inventory.inventories
    .filter(i => ['hotbar', 'backpack'].includes(i.name))
    .flatMap(i => i.slots.filter(s => i.name !== 'hotbar' || s.slot < 10).map(s => ({ ...s, inventory: i.name })));
export const itemCount = (inventory, code) =>
  ownedSlots(inventory)
    .filter(s => s.code === code)
    .reduce((n, s) => n + s.quantity, 0);
export const carriedCount = (state, code) =>
  [...state.hotbar.filter(s => s.slot < 10), ...state.backpack].filter(s => s.code === code).reduce((n, s) => n + s.quantity, 0);

export async function equip(field, { item, tool, minTier = 0, slot }: { item?: any; tool?: string; minTier?: number; slot?: number }) {
  await field.observe();
  let inventory = await field.send({ action: 'inventory' });
  const slots = ownedSlots(inventory);
  const matches = s => (tool !== undefined ? s.code && s.tool === tool && s.toolTier >= minTier && s.durability > 0 : s.code === item);
  const source = slots
    .filter(s => matches(s) && (s.code ? s.quantity > 0 : s.inventory === 'hotbar'))
    .sort(
      (a, b) =>
        (tool ? a.toolTier - b.toolTier : 0) ||
        Number(b.inventory === 'hotbar') - Number(a.inventory === 'hotbar') ||
        Number(b.slot === slot) - Number(a.slot === slot) ||
        (b.durability ?? 0) - (a.durability ?? 0),
    )[0];
  if (!source) throw Error('No matching owned item/tool or empty hand slot');
  let destination =
    slot === undefined
      ? source.inventory === 'hotbar'
        ? source
        : slots.find(s => s.inventory === 'hotbar' && !s.code)
      : slots.find(s => s.inventory === 'hotbar' && s.slot === slot);
  if (!destination) throw Error('Equip needs an empty ordinary hotbar slot');
  const same = source.inventory === 'hotbar' && source.slot === destination.slot;
  if (!same && destination.code) throw Error('Requested hotbar slot occupied; no swap or overwrite');
  const from = { inventory: source.inventory, slot: source.slot };
  let moved = 0;
  if (!same && source.code) {
    field.report('equipping', { item: source.code, from, slot: destination.slot });
    await field.observe();
    await field.send({
      action: 'inventory_move',
      from,
      to: { inventory: 'hotbar', slot: destination.slot },
      quantity: 1,
      expectedState: inventory.state,
    });
    const transfer = await field.until(
      (_, contents) => {
        const current = ownedSlots(contents);
        const received = current.find(s => s.inventory === 'hotbar' && s.slot === destination.slot);
        const remaining = current.find(s => s.inventory === source.inventory && s.slot === source.slot);
        return (
          received?.code === source.code &&
          received.quantity === 1 &&
          matches(received) &&
          remaining?.quantity === source.quantity - 1 &&
          (remaining.quantity === 0 || remaining.code === source.code) &&
          itemCount(contents, source.code) === itemCount(inventory, source.code)
        );
      },
      { timeoutMs: 2000, everyMs: 200, read: () => field.send({ action: 'inventory' }) },
    );
    if (!transfer.met) throw Error('Equip transfer unverified; inspect inventory before another attempt');
    inventory = transfer.read;
    destination = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && s.slot === destination.slot);
    moved = 1;
  }
  await field.observe();
  await field.send({ action: 'select', slot: destination.slot });
  const after = (await field.until(state => state.activeSlot === destination.slot, { timeoutMs: 400, everyMs: 100 })).state;
  inventory = await field.send({ action: 'inventory' });
  const held = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && s.slot === destination.slot);
  if (after.activeSlot !== destination.slot || !held || !matches(held) || held.code !== source.code)
    throw Error('Equipment selection unverified; inspect before another attempt');
  return {
    ok: true,
    goal: 'equip',
    slot: held.slot,
    item: held.code,
    tool: held.tool,
    toolTier: held.toolTier,
    durability: held.durability,
    moved,
    from,
    verification: 'client_observed',
  };
}
