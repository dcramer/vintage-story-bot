using System.Reflection;
using System.Text;
using Vintagestory.API.Client;
using Vintagestory.API.Common;
using Vintagestory.API.Util;
using Vintagestory.GameContent;

namespace VintageStoryAI;

// One look at the handbook page of an item or block: the facts the page is
// drawn from (nutrition, drops, harvest, tool, fuel) and its text. Reading a
// page is one player act; which pages matter is Node's to decide from what
// the eye has seen.
internal sealed class HandbookSensor(ICoreClientAPI api)
{
    private static readonly FieldInfo? StackSlot = typeof(ItemstackTextComponent).GetField("slot", BindingFlags.NonPublic | BindingFlags.Instance);
    private static readonly FieldInfo? HarvestSeconds = typeof(BlockBehaviorHarvestable).GetField("harvestTime", BindingFlags.NonPublic | BindingFlags.Instance);

    public object ItemInfo(string code)
    {
        var location = new AssetLocation(code);
        CollectibleObject? collectible = api.World.GetItem(location) ?? (CollectibleObject?)api.World.GetBlock(location);
        if (collectible?.Code == null || collectible.Id == 0) return new { ok = false, error = "No handbook page for that code." };
        var stack = new ItemStack(collectible);
        var slot = new DummySlot(stack);
        var block = collectible as Block;
        var nutrition = collectible.GetNutritionProperties(api.World, stack, api.World.Player.Entity);
        var fuel = collectible.CombustibleProps;
        string? name;
        try { name = collectible.GetHeldItemName(stack); } catch { name = null; }
        return new
        {
            ok = true, observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            code = collectible.Code.ToString(), type = block == null ? "item" : "block", name = Clip(name, 96),
            maxStackSize = collectible.MaxStackSize,
            tool = collectible.Tool?.ToString(), toolTier = collectible.ToolTier,
            durability = collectible.Tool == null && collectible.Durability <= 1 ? (int?)null : collectible.GetMaxDurability(stack),
            bagSlots = collectible.Attributes?["backpack"]?["quantitySlots"]?.AsInt(0) is > 0 and var slots ? slots : (int?)null,
            nutrition = nutrition == null ? null : new
            {
                saturation = nutrition.Satiety, health = nutrition.Health, category = nutrition.FoodCategory.ToString(),
                intoxication = nutrition.Intoxication, psychedelic = nutrition.Psychedelic
            },
            combustible = fuel == null ? null : new
            {
                burnTemperature = fuel.BurnTemperature, burnDuration = fuel.BurnDuration, meltingPoint = fuel.MeltingPoint,
                smeltsInto = fuel.SmeltedStack?.ResolvedItemstack?.Collectible?.Code?.ToString(), smeltedRatio = fuel.SmeltedRatio
            },
            drops = block == null ? null : Drops(SafeDrops(block, stack)),
            harvest = block == null ? null : Harvest(block),
            text = PageText(collectible, slot)
        };
    }

    private BlockDropItemStack[]? SafeDrops(Block block, ItemStack stack)
    {
        try { return block.GetDropsForHandbook(stack, api.World.Player); } catch { return null; }
    }

    private static object[]? Drops(BlockDropItemStack[]? drops) => drops?
        .Where(drop => drop?.ResolvedItemstack?.Collectible?.Code != null).Take(16)
        .Select(drop => new
        {
            code = drop.ResolvedItemstack!.Collectible.Code.ToString(), quantity = Math.Round(drop.Quantity?.avg ?? 1, 2),
            tool = drop.Tool?.ToString(), lastDrop = drop.LastDrop
        }).ToArray();

    // Right-click harvesting a block leaves it in place and yields these.
    private static object? Harvest(Block block)
    {
        if (block.GetBehavior(typeof(BlockBehaviorHarvestable), true) is BlockBehaviorHarvestable harvestable && harvestable.harvestedStacks != null)
            return new
            {
                drops = Drops(harvestable.harvestedStacks), tool = harvestable.Tool?.ToString(),
                seconds = HarvestSeconds?.GetValue(harvestable) is float seconds ? Math.Round(seconds, 2) : (double?)null, requiresGrowth = (string?)null
            };
        if (block.GetBehavior(typeof(BlockBehaviorFruitingBush), true) is BlockBehaviorFruitingBush bush && bush.harvestedStacks != null)
            return new { drops = Drops(bush.harvestedStacks), tool = (string?)null, seconds = (double?)Math.Round(bush.harvestTime, 2), requiresGrowth = "ripe" };
        return null;
    }

    // The page as the player reads it: text with item links as [code].
    private string[]? PageText(CollectibleObject collectible, ItemSlot slot)
    {
        if (collectible.GetCollectibleBehavior(typeof(CollectibleBehaviorHandbookTextAndExtraInfo), true) is not CollectibleBehaviorHandbookTextAndExtraInfo behavior)
            return null;
        var all = ObjectCacheUtil.TryGet<ItemStack[]>(api, "handbookallstacks") ?? [];
        RichTextComponentBase[] components;
        try { components = behavior.GetHandbookInfo(slot, api, all, _ => true); }
        catch (Exception error) { return [$"[handbook page unavailable: {error.GetType().Name}]"]; }
        var text = new StringBuilder();
        foreach (var component in components)
        {
            switch (component)
            {
                case ClearFloatTextComponent: text.Append('\n'); break;
                case SlideshowItemstackTextComponent slideshow:
                    text.Append('[').Append(string.Join(", ", (slideshow.Itemstacks ?? []).Take(12)
                        .Select(s => s?.Collectible?.Code?.ToString()).Where(c => c != null))).Append("] ");
                    break;
                case ItemstackTextComponent item:
                    if ((StackSlot?.GetValue(item) as ItemSlot)?.Itemstack?.Collectible?.Code?.ToString() is { } code)
                        text.Append('[').Append(code).Append("] ");
                    break;
                case RichTextComponent rich: text.Append(rich.DisplayText); break;
            }
            try { component.Dispose(); } catch { }
        }
        var lines = text.ToString().Replace("\r", "").Split('\n').Select(line => line.Trim()).Where(line => line.Length > 0).Take(80).ToArray();
        int budget = 6000;
        return lines.TakeWhile(line => (budget -= line.Length) >= 0).Select(line => Clip(line, 400)!).ToArray();
    }

    private static string? Clip(string? value, int limit) => value == null ? null : value[..Math.Min(limit, value.Length)];
}
