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

export async function equip(
  field,
  { item, tool, minTier = 0, slot, quantity = 1 }: { item?: any; tool?: string; minTier?: number; slot?: number; quantity?: number },
) {
  await field.observe();
  let inventory = await field.send({ action: 'inventory' });
  const inventorySlot = (contents, address) => {
    const own = contents.inventories.find(i => i.name === address.inventory);
    return own?.slots.find(s => s.slot === address.slot);
  };
  const slots = ownedSlots(inventory);
  const matches = s => (tool !== undefined ? s.code && s.tool === tool && s.toolTier >= minTier && s.durability > 0 : s.code === item);
  const source = slots
    .filter(s => matches(s) && (s.code ? s.quantity >= quantity : s.inventory === 'hotbar'))
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
  let rotated = false;
  if (!destination && slot === undefined && source.inventory !== 'hotbar') {
    const storage = slots.find(s => s.inventory === 'backpack' && !s.bag && !s.code);
    const displaced = slots.find(s => s.inventory === 'hotbar' && s.code && !s.tool && s.slot !== field.latest.activeSlot && s.code !== source.code);
    if (storage && displaced) {
      field.report('making hotbar room', { item: displaced.code, from: displaced.slot, to: storage.slot });
      await field.observe();
      await field.send({
        action: 'inventory_move',
        from: { inventory: 'hotbar', slot: displaced.slot },
        to: { inventory: 'backpack', slot: storage.slot },
        quantity: displaced.quantity,
        expectedState: inventory.state,
      });
      const transfer = await field.until(
        (_, contents) => {
          const current = ownedSlots(contents);
          const freed = current.find(s => s.inventory === 'hotbar' && s.slot === displaced.slot);
          const stored = current.find(s => s.inventory === 'backpack' && s.slot === storage.slot);
          return (
            !freed?.code &&
            stored?.code === displaced.code &&
            stored.quantity === displaced.quantity &&
            itemCount(contents, displaced.code) === itemCount(inventory, displaced.code)
          );
        },
        { timeoutMs: 2000, everyMs: 200, read: () => field.send({ action: 'inventory' }) },
      );
      if (!transfer.met) throw Error('Hotbar room transfer unverified; inspect inventory before another attempt');
      inventory = transfer.read;
      destination = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && s.slot === displaced.slot);
    } else {
      const mouse = inventory.inventories.find(i => i.name === 'mouse')?.slots.find(s => !s.code);
      const cursorRoom = slots
        .filter(
          s =>
            s.inventory === 'hotbar' &&
            s.code &&
            !s.tool &&
            s.quantity > 0 &&
            s.quantity <= 64 &&
            s.slot !== field.latest.activeSlot &&
            s.code !== source.code,
        )
        .sort((a, b) => a.quantity - b.quantity || a.slot - b.slot)[0];
      if (mouse && cursorRoom && source.quantity <= 64) {
        const hotbar = { inventory: 'hotbar', slot: cursorRoom.slot };
        const cursor = { inventory: 'mouse', slot: mouse.slot };
        const sourceSlot = { inventory: source.inventory, slot: source.slot };
        field.report('rotating hotbar room', { item: cursorRoom.code, from: cursorRoom.slot, to: sourceSlot.slot });
        await field.send({
          action: 'inventory_move',
          from: hotbar,
          to: cursor,
          quantity: cursorRoom.quantity,
          expectedState: inventory.state,
        });
        const parked = await field.until(
          (_, contents) =>
            !inventorySlot(contents, hotbar)?.code &&
            inventorySlot(contents, cursor)?.code === cursorRoom.code &&
            inventorySlot(contents, cursor)?.quantity === cursorRoom.quantity,
          { timeoutMs: 2000, everyMs: 200, read: () => field.send({ action: 'inventory' }) },
        );
        if (!parked.met) throw Error('Cursor parking unverified; inspect inventory before another attempt');
        inventory = parked.read;
        await field.send({
          action: 'inventory_move',
          from: sourceSlot,
          to: hotbar,
          quantity: source.quantity,
          expectedState: inventory.state,
        });
        const equipped = await field.until(
          (_, contents) =>
            inventorySlot(contents, hotbar)?.code === source.code &&
            inventorySlot(contents, hotbar)?.quantity === source.quantity &&
            !inventorySlot(contents, sourceSlot)?.code,
          { timeoutMs: 2000, everyMs: 200, read: () => field.send({ action: 'inventory' }) },
        );
        if (!equipped.met) throw Error('Equip rotation unverified; inspect inventory before another attempt');
        inventory = equipped.read;
        await field.send({
          action: 'inventory_move',
          from: cursor,
          to: sourceSlot,
          quantity: cursorRoom.quantity,
          expectedState: inventory.state,
        });
        const restored = await field.until(
          (_, contents) =>
            !inventorySlot(contents, cursor)?.code &&
            inventorySlot(contents, sourceSlot)?.code === cursorRoom.code &&
            inventorySlot(contents, sourceSlot)?.quantity === cursorRoom.quantity,
          { timeoutMs: 2000, everyMs: 200, read: () => field.send({ action: 'inventory' }) },
        );
        if (!restored.met) throw Error('Cursor restoration unverified; inspect inventory before another attempt');
        inventory = restored.read;
        destination = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && s.slot === cursorRoom.slot);
        rotated = true;
      }
    }
  }
  if (!destination) throw Error('Equip needs an empty ordinary hotbar slot');
  const same = source.inventory === 'hotbar' && source.slot === destination.slot;
  if (!same && destination.code && !rotated) throw Error('Requested hotbar slot occupied; no swap or overwrite');
  const from = { inventory: source.inventory, slot: source.slot };
  let moved = rotated ? source.quantity : 0;
  if (!same && source.code && !rotated) {
    field.report('equipping', { item: source.code, from, slot: destination.slot });
    await field.observe();
    await field.send({
      action: 'inventory_move',
      from,
      to: { inventory: 'hotbar', slot: destination.slot },
      quantity,
      expectedState: inventory.state,
    });
    const transfer = await field.until(
      (_, contents) => {
        const current = ownedSlots(contents);
        const received = current.find(s => s.inventory === 'hotbar' && s.slot === destination.slot);
        const remaining = current.find(s => s.inventory === source.inventory && s.slot === source.slot);
        return (
          received?.code === source.code &&
          received.quantity === quantity &&
          matches(received) &&
          remaining?.quantity === source.quantity - quantity &&
          (remaining.quantity === 0 || remaining.code === source.code) &&
          itemCount(contents, source.code) === itemCount(inventory, source.code)
        );
      },
      { timeoutMs: 2000, everyMs: 200, read: () => field.send({ action: 'inventory' }) },
    );
    if (!transfer.met) throw Error('Equip transfer unverified; inspect inventory before another attempt');
    inventory = transfer.read;
    destination = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && s.slot === destination.slot);
    moved = quantity;
  }
  await field.observe();
  await field.send({ action: 'select', slot: destination.slot });
  const after = (await field.until(state => state.activeSlot === destination.slot, { timeoutMs: 400, everyMs: 100 })).state;
  inventory = await field.send({ action: 'inventory' });
  const held = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && s.slot === destination.slot);
  if (after.activeSlot !== destination.slot || !held || held.quantity < quantity || !matches(held) || held.code !== source.code)
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
