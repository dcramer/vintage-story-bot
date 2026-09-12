using System.Security.Cryptography;
using System.Text.Json;
using Vintagestory.API.Client;
using Vintagestory.API.Common;
using Vintagestory.Client.NoObf;

namespace VintageStoryAI;

// Native world-container access: open by right-clicking the aimed block for
// real, move through the game's transfer path, close with the manager's own
// sync packet. Only inventories the player legitimately opened are touched.
public sealed class ContainerAdapter(ICoreClientAPI api)
{
    private static readonly string[] Own = ["hotbar", "backpack", "craftinggrid", "mouse"];
    private readonly string session = Guid.NewGuid().ToString("N");
    private long mutation;
    private IInventory? open;
    private IPlayerInventoryManager Manager => api.World.Player.InventoryManager;

    private string State(IInventory inventory)
    {
        using var bytes = new MemoryStream();
        using var writer = new BinaryWriter(bytes);
        writer.Write(session);
        writer.Write(mutation);
        writer.Write(inventory.InventoryID);
        writer.Write(inventory.Count);
        foreach (var slot in inventory)
        {
            writer.Write(!slot.Empty);
            slot.Itemstack?.ToBytes(writer);
        }
        return Convert.ToHexString(SHA256.HashData(bytes.ToArray())).ToLowerInvariant();
    }

    private object Slots(IInventory inventory) => new
    {
        ok = true, inventoryId = inventory.InventoryID, state = State(inventory),
        slots = Enumerable.Range(0, inventory.Count).Select(index => new
        {
            slot = index, code = inventory[index]?.Itemstack?.Collectible.Code.ToString(),
            quantity = inventory[index]?.StackSize ?? 0
        }).ToArray()
    };

    private bool OwnInventory(IInventory inventory) =>
        Own.Select(name => Manager.GetOwnInventory(name)).Any(own => own != null && own == inventory);

    private IInventory? Candidate() => Manager.OpenedInventories
        .Where(inventory => inventory != null && !OwnInventory(inventory) && inventory.HasOpened(api.World.Player))
        .FirstOrDefault();

    private void CloseSession()
    {
        if (open != null) Manager.CloseInventoryAndSync(open);
        open = null;
    }

    public object Open(JsonElement request, SystemMouseInWorldInteractions? interactions, float dt)
    {
        if (!api.World.Player.Entity.Alive || api.IsGamePaused) return Error("Cannot open a container while dead or paused.");
        CloseSession();
        // A real right-click on the aimed block; the server learns it from the
        // same hand-interaction packet a human's click sends. Pump a few frames
        // synchronously: the client dialog opens on interact start.
        api.Input.InWorldMouseButton.Right = true;
        try
        {
            for (int i = 0; i < 12 && Candidate() == null; i++) interactions?.OnFinalizeFrame(dt);
        }
        finally { api.Input.InWorldMouseButton.Right = false; }
        var found = Candidate();
        if (found == null) return Error("No container opened; aim at a chest, vessel or basket within reach and retry.");
        open = found;
        mutation++;
        return Slots(open);
    }

    private ItemSlot? Resolve(JsonElement request, string field)
    {
        if (!request.TryGetProperty(field, out var address) || address.ValueKind != JsonValueKind.Object ||
            !address.TryGetProperty("inventory", out var name) || name.ValueKind != JsonValueKind.String ||
            !address.TryGetProperty("slot", out var index) || index.ValueKind != JsonValueKind.Number || !index.TryGetInt32(out int i)) return null;
        if (name.GetString() == "container")
            return open != null && i >= 0 && i < open.Count ? open[i] : null;
        string inventoryName = name.GetString()!;
        if (!Own.Contains(inventoryName)) return null;
        var inventory = Manager.GetOwnInventory(inventoryName);
        if (inventory == null || i < 0 || i >= inventory.Count || (inventoryName == "craftinggrid" && i >= 9)) return null;
        return inventory[i];
    }

    public object Move(JsonElement request)
    {
        if (!api.World.Player.Entity.Alive || api.IsGamePaused) return Error("Cannot change inventory while dead or paused.");
        if (open == null) return Error("No container open; open_container first.");
        if (!request.TryGetProperty("expectedState", out var expected) || expected.ValueKind != JsonValueKind.String || expected.GetString() != State(open))
            return Error("Container changed; read open_container again. Nothing moved.");
        var source = Resolve(request, "from");
        var target = Resolve(request, "to");
        if (source == null || target == null || source == target || source.Empty) return Error("Invalid, identical, or empty inventory slots.");
        bool touchesContainer = source.Inventory == open || target.Inventory == open;
        if (!touchesContainer) return Error("One end of a container move must be the open container.");
        if (!request.TryGetProperty("quantity", out var count) || count.ValueKind != JsonValueKind.Number ||
            !count.TryGetInt32(out int quantity) || quantity < 1 || quantity > 64 || quantity > source.StackSize)
            return Error("quantity must be 1–64 and available in source.");
        var op = new ItemStackMoveOperation(api.World, EnumMouseButton.Left, 0, EnumMergePriority.DirectMerge, quantity)
        { ActingPlayer = api.World.Player };
        // The game's normal synchronization packet; never assign stacks ourselves.
        mutation++;
        var packet = Manager.TryTransferTo(source, target, ref op);
        if (packet != null) api.Network.SendPacketClient(packet);
        return new { ok = op.MovedQuantity > 0, status = "submitted", moved = op.MovedQuantity,
            error = op.MovedQuantity > 0 ? null : "No items moved; read open_container before retrying.", state = State(open) };
    }

    public object Close()
    {
        if (open == null) return new { ok = true, status = "already_closed" };
        CloseSession();
        return new { ok = true, status = "closed" };
    }

    private static object Error(string error) => new { ok = false, error };
}
