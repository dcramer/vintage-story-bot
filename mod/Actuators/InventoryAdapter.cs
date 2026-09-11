using System.Security.Cryptography;
using System.Text.Json;
using Vintagestory.API.Client;
using Vintagestory.API.Common;
using Vintagestory.API.Datastructures;
using Vintagestory.Common;

namespace VintageStoryAI;

public sealed class InventoryAdapter(ICoreClientAPI api)
{
    private static readonly string[] Names = ["hotbar", "backpack", "craftinggrid", "mouse"];
    private readonly string session = Guid.NewGuid().ToString("N");
    private long mutation;
    private IPlayerInventoryManager Manager => api.World.Player.InventoryManager;

    private IEnumerable<(string name, IInventory inventory)> Inventories() => Names
        .Select(name => (name, inventory: Manager.GetOwnInventory(name)))
        .Where(pair => pair.inventory != null);

    private string State()
    {
        using var bytes = new MemoryStream();
        using var writer = new BinaryWriter(bytes);
        writer.Write(session);
        writer.Write(mutation);
        foreach (var (name, inventory) in Inventories())
        {
            writer.Write(name);
            writer.Write(inventory.Count);
            foreach (var slot in inventory)
            {
                writer.Write(!slot.Empty);
                slot.Itemstack?.ToBytes(writer);
            }
        }
        return Convert.ToHexString(SHA256.HashData(bytes.ToArray())).ToLowerInvariant();
    }

    public bool Matches(string? expected) => expected == State();

    public object Observe() => new
    {
        ok = true, observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), state = State(),
        inventories = Inventories().Select(pair => new
        {
            name = pair.name,
            slots = Enumerable.Range(0, pair.inventory.Count).Select(index => SlotInfo(pair.inventory[index], index)).ToArray()
        }).ToArray(),
        equipment = new
        {
            character = CharacterSlots(), offhand = SlotInfo(Manager.OffhandHotbarSlot, -1)
        },
        crafting = new { width = 3, inputSlots = Enumerable.Range(0, 9), outputSlot = 9,
            recipeId = (Manager.GetOwnInventory("craftinggrid") as InventoryCraftingGrid)?.MatchingRecipe?.RecipeId }
    };

    private object[]? CharacterSlots()
    {
        var character = Manager.GetOwnInventory("character");
        return character == null ? null : Enumerable.Range(0, Math.Min(character.Count, 64))
            .Select(index => SlotInfo(character[index], index)).ToArray();
    }

    private object SlotInfo(ItemSlot? slot, int index)
    {
        var stack = slot?.Itemstack;
        var nutrition = stack?.Collectible.GetNutritionProperties(api.World, stack, api.World.Player.Entity);
        return new { slot = index, code = stack?.Collectible.Code.ToString(), quantity = slot?.StackSize ?? 0,
            itemClass = stack?.Class.ToString(),
            dressType = (slot as ItemSlotCharacter)?.Type.ToString(),
            tool = stack?.Collectible.Tool?.ToString(), toolTier = stack?.Collectible.ToolTier,
            durability = stack == null ? (int?)null : stack.Collectible.GetRemainingDurability(stack),
            maxDurability = stack == null ? (int?)null : stack.Collectible.GetMaxDurability(stack),
            freshness = Freshness(slot),
            nutrition = nutrition == null ? null : new { saturation = nutrition.Satiety, health = nutrition.Health,
                category = nutrition.FoodCategory.ToString() } };
    }

    private object? Freshness(ItemSlot? slot)
    {
        var stack = slot?.Itemstack;
        if (stack == null) return null;
        var properties = stack.Collectible.GetTransitionableProperties(api.World, stack, api.World.Player.Entity);
        int index = Array.FindIndex(properties ?? [], property => property.Type == EnumTransitionType.Perish);
        if (index < 0) return new { state = "nonperishable", freshHoursLeft = (double?)null };
        var tree = stack.Attributes.GetTreeAttribute("transitionstate");
        var fresh = (tree?["freshHours"] as FloatArrayAttribute)?.value;
        var elapsed = (tree?["transitionedHours"] as FloatArrayAttribute)?.value;
        if (fresh == null || elapsed == null || index >= fresh.Length || index >= elapsed.Length ||
            tree?.HasAttribute("lastUpdatedTotalHours") != true) return null;
        // Mirror elapsed-age arithmetic without updating stacks or drawing random freshness values.
        double age = api.World.Calendar.TotalHours - tree.GetDouble("lastUpdatedTotalHours");
        // Rate lookup can cool temperature attributes; isolate those writes on a clone.
        var copy = new ItemSlot(slot!.Inventory) { Itemstack = stack.Clone() };
        double rate = stack.Collectible.GetTransitionRateMul(api.World, copy, EnumTransitionType.Perish);
        double left = fresh[index] - elapsed[index] - Math.Max(0, age) * rate;
        if (!double.IsFinite(left) || !double.IsFinite(rate) || rate < 0 || age < 0) return null;
        return new { state = left > 0 ? "fresh" : "spoiling", freshHoursLeft = (double?)Math.Max(0, left) };
    }

    private ItemSlot? Resolve(JsonElement request, string field, bool allowGrid)
    {
        if (!request.TryGetProperty(field, out var address) || address.ValueKind != JsonValueKind.Object ||
            !address.TryGetProperty("inventory", out var name) || name.ValueKind != JsonValueKind.String ||
            !address.TryGetProperty("slot", out var index) || index.ValueKind != JsonValueKind.Number || !index.TryGetInt32(out int i)) return null;
        string inventoryName = name.GetString()!;
        if (!Names.Contains(inventoryName) || (!allowGrid && inventoryName == "craftinggrid")) return null;
        var inventory = Manager.GetOwnInventory(inventoryName);
        if (inventory == null || i < 0 || i >= inventory.Count || (inventoryName == "craftinggrid" && i >= 9)) return null;
        return inventory[i];
    }

    public object Move(JsonElement request, bool craft)
    {
        if (!api.World.Player.Entity.Alive || api.IsGamePaused) return Error("Cannot change inventory while dead or paused.");
        if (!request.TryGetProperty("expectedState", out var expected) || expected.ValueKind != JsonValueKind.String || expected.GetString() != State())
            return Error("Inventory changed; read inventory and replan. Nothing moved.");
        var target = Resolve(request, "to", !craft);
        var source = craft ? Manager.GetOwnInventory("craftinggrid")?[9] : Resolve(request, "from", true);
        if (source == null || target == null || source == target || source.Empty) return Error("Invalid, identical, or empty inventory slots.");
        int quantity;
        if (craft)
        {
            if (!request.TryGetProperty("expectedOutput", out var output) || output.ValueKind != JsonValueKind.String ||
                output.GetString() != source.Itemstack.Collectible.Code.ToString()) return Error("Crafting output changed; inspect inventory.");
            quantity = source.StackSize;
            // Avoid partial output extraction and implicit drops/merges; one complete craft into an empty slot.
            if (!target.Empty || target.GetRemainingSlotSpace(source.Itemstack) < quantity || !target.CanTakeFrom(source))
                return Error("Craft needs an empty destination with room for the entire output.");
        }
        else if (!request.TryGetProperty("quantity", out var count) || count.ValueKind != JsonValueKind.Number ||
            !count.TryGetInt32(out quantity) || quantity < 1 || quantity > 64 || quantity > source.StackSize)
            return Error("quantity must be 1–64 and available in source.");

        var op = new ItemStackMoveOperation(api.World, EnumMouseButton.Left, 0, EnumMergePriority.DirectMerge, quantity)
        { ActingPlayer = api.World.Player };
        // Returns the game's normal synchronization packet; never assign/create stacks ourselves.
        mutation++;
        var packet = Manager.TryTransferTo(source, target, ref op);
        if (packet != null) api.Network.SendPacketClient(packet);
        return new { ok = op.MovedQuantity > 0, status = "submitted", moved = op.MovedQuantity,
            error = op.MovedQuantity > 0 ? null : "No items moved; inspect inventory before retrying.", state = State() };
    }

    public object Recipes(string match, int offset, int limit)
    {
        var recipes = api.World.GridRecipes.Where(recipe => recipe.Enabled && recipe.Width <= 3 && recipe.Height <= 3 &&
            recipe.Output?.Code?.ToString().Contains(match, StringComparison.OrdinalIgnoreCase) == true).Skip(offset).Take(limit + 1).ToArray();
        var held = Inventories().SelectMany(pair => Enumerable.Range(0, pair.inventory.Count)
            .Where(i => pair.name != "craftinggrid" || i < 9)
            .Select(i => (pair.name, index: i, slot: pair.inventory[i]))).Where(item => item.slot?.Empty == false).ToArray();
        return new { ok = true, offset, more = recipes.Length > limit, recipes = recipes.Take(limit).Select(recipe => new
        {
            id = recipe.RecipeId, name = recipe.Name?.ToString(), width = recipe.Width, height = recipe.Height,
            shapeless = recipe.Shapeless, output = new { code = recipe.Output!.Code?.ToString(), quantity = recipe.Output.Quantity },
            ingredients = recipe.ResolvedIngredients?.Select((ingredient, i) => ingredient == null ? null : new
            {
                slot = i / recipe.Width * 3 + i % recipe.Width, code = ingredient.Code?.ToString(), quantity = ingredient.Quantity,
                consume = ingredient.Consume, durabilityChange = ingredient.DurabilityChange,
                matches = held.Where(item => ingredient.SatisfiesAsIngredient(item.slot!.Itemstack!, false))
                    .Select(item => new { inventory = item.name, slot = item.index, quantity = item.slot!.StackSize }).ToArray()
            }).ToArray()
        }).ToArray() };
    }

    private static object Error(string error) => new { ok = false, error };
}
