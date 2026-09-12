using System.Reflection;
using System.Text;
using System.Text.Json;
using Vintagestory.API.Client;
using Vintagestory.API.Common;
using Vintagestory.API.Common.Entities;
using Vintagestory.API.Config;
using Vintagestory.API.Util;
using Vintagestory.GameContent;

namespace VintageStoryAI;

// The handbook as data: one item/block/creature page per code, or the whole
// index in pages. Same facts either way; the catalog batches what item_info
// reads one code at a time. Public game data, never world state. The game's
// own typing (class, material, behaviors, tier) is reported as read; what a
// thing is for (its traits) is Node's reading of these facts.
internal sealed class HandbookSensor(ICoreClientAPI api)
{
    private static readonly FieldInfo? StackSlot = typeof(ItemstackTextComponent).GetField("slot", BindingFlags.NonPublic | BindingFlags.Instance);

    // text:false leaves out the page body: the facts of one code, cheap enough to read on first sight.
    public object ItemInfo(string code, bool text = true)
    {
        var location = new AssetLocation(code);
        CollectibleObject? collectible = api.World.GetItem(location) ?? (CollectibleObject?)api.World.GetBlock(location);
        var page = new Dictionary<string, object?> { ["ok"] = true, ["observedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
        if (collectible?.Code != null && collectible.Id != 0)
            foreach (var (key, value) in Entry(collectible, text ? -1 : 0)) page[key] = value;
        else if (api.World.GetEntityType(location) is { Code: not null } creature)
            foreach (var (key, value) in Entry(creature)) page[key] = value;
        else return new { ok = false, error = "No handbook page for that code." };
        return page;
    }

    // The handbook's search box: every loaded block, item and creature whose
    // code or name contains match, stable-sorted by code, a page at a time.
    // Facts only unless text:true asks for a short description, which renders
    // each page on the game thread and is slow.
    private readonly Dictionary<string, (CollectibleObject[] All, EntityProperties[] Creatures)> catalogListings = new();
    public object CatalogPage(JsonElement request)
    {
        int offset = 0, limit = 50;
        if (request.TryGetProperty("offset", out var offsetField) && (!offsetField.TryGetInt32(out offset) || offset < 0 || offset > 100000) ||
            request.TryGetProperty("limit", out var limitField) && (!limitField.TryGetInt32(out limit) || limit < 1 || limit > 100))
            return new { ok = false, error = "offset: 0–100000; limit: 1–100." };
        bool text = request.TryGetProperty("text", out var textField) && textField.ValueKind == JsonValueKind.True;
        string match = request.TryGetProperty("match", out var matchField) && matchField.ValueKind == JsonValueKind.String ? matchField.GetString()!.ToLowerInvariant() : "";
        if (match.Length > 64) return new { ok = false, error = "match: at most 64 characters." };
        string? type = request.TryGetProperty("type", out var typeField) && typeField.ValueKind == JsonValueKind.String ? typeField.GetString() : null;
        bool Matches(string code, Func<string?> name) => match.Length == 0 || code.ToLowerInvariant().Contains(match) || (name()?.ToLowerInvariant().Contains(match) ?? false);
        // The filtered, sorted listing is the expensive part (a name rendered per collectible): kept per
        // query for the session, so paging through it costs one page, not the whole catalog each time.
        string listing = match + "|" + (type ?? "");
        if (!catalogListings.TryGetValue(listing, out var listed))
        {
            CollectibleObject[] collectibles = type == "entity" ? [] : api.World.Collectibles
                .Where(collectible => collectible != null && collectible.Code != null && collectible.Id != 0 && (type == null || (collectible is Block ? "block" : "item") == type))
                .Where(collectible => Matches(collectible.Code.ToString(), () => collectible.GetHeldItemName(new ItemStack(collectible))))
                .OrderBy(collectible => collectible.Code.ToString(), StringComparer.Ordinal).ToArray();
            EntityProperties[] entities = type != null && type != "entity" ? [] : api.World.EntityTypes.Where(t => t?.Code != null)
                .Where(t => Matches(t.Code.ToString(), () => CreatureName(t)))
                .OrderBy(t => t.Code.ToString(), StringComparer.Ordinal).ToArray();
            if (catalogListings.Count >= 16) catalogListings.Clear();
            catalogListings[listing] = listed = (collectibles, entities);
        }
        var (all, creatures) = listed;
        int total = all.Length + creatures.Length;
        var entries = all.Skip(offset).Take(limit).Select(collectible => Entry(collectible, text ? 3 : 0))
            .Concat(creatures.Skip(Math.Max(0, offset - all.Length)).Take(Math.Max(0, limit - Math.Max(0, all.Length - offset))).Select(Entry))
            .ToArray();
        return new { ok = true, offset, total, more = offset + entries.Length < total, entries };
    }

    // One handbook page as facts. maxTextLines < 0 keeps the full page body as
    // text; 0 reads no body; otherwise the first lines become a short desc.
    private Dictionary<string, object?> Entry(CollectibleObject collectible, int maxTextLines)
    {
        var stack = new ItemStack(collectible);
        var slot = new DummySlot(stack);
        var block = collectible as Block;
        var nutrition = collectible.GetNutritionProperties(api.World, stack, api.World.Player.Entity);
        var fuel = collectible.CombustibleProps;
        int bagSlots = collectible.Attributes?["backpack"]?["quantitySlots"]?.AsInt(0) ?? 0;
        var entry = new Dictionary<string, object?>
        {
            ["code"] = collectible.Code.ToString(),
            ["type"] = block == null ? "item" : "block",
            ["name"] = ContextSensor.Clip(collectible.GetHeldItemName(stack), 96),
            // The game's own typing: the C# class the asset names, the block material,
            // and the behaviors attached (RightClickPickup, Harvestable, Unstable...).
            ["class"] = collectible.GetType().Name,
            ["material"] = block?.BlockMaterial.ToString(),
            ["behaviors"] = Behaviors(collectible),
            ["miningTier"] = block == null ? null : block.RequiredMiningTier,
            ["resistance"] = block == null ? null : Math.Round(block.Resistance, 2),
            ["climbable"] = block == null ? null : block.Climbable,
            ["replaceable"] = block == null ? null : block.Replaceable,
            ["liquid"] = block?.LiquidCode,
            ["maxStackSize"] = collectible.MaxStackSize,
            ["tool"] = collectible.Tool?.ToString(),
            ["toolTier"] = collectible.ToolTier,
            ["durability"] = collectible.Durability > 1 ? collectible.GetMaxDurability(stack) : (int?)null,
            ["bagSlots"] = bagSlots > 0 ? bagSlots : (int?)null,
            ["nutrition"] = nutrition == null ? null : new
            {
                saturation = nutrition.Satiety, health = nutrition.Health, category = nutrition.FoodCategory.ToString(),
                intoxication = nutrition.Intoxication, psychedelic = nutrition.Psychedelic
            },
            ["combustible"] = fuel == null ? null : new
            {
                burnTemperature = fuel.BurnTemperature, burnDuration = fuel.BurnDuration, meltingPoint = fuel.MeltingPoint,
                smeltsInto = fuel.SmeltedStack?.ResolvedItemstack?.Collectible?.Code?.ToString(), smeltedRatio = fuel.SmeltedRatio
            },
            ["drops"] = block == null ? null : Drops(block.GetDropsForHandbook(stack, api.World.Player)),
            ["harvest"] = block == null ? null : Harvest(block),
        };
        if (maxTextLines == 0) return entry;
        var text = PageText(collectible, slot);
        if (maxTextLines < 0) entry["text"] = text;
        else entry["desc"] = text == null ? null : ContextSensor.Clip(string.Join(" ", text.Take(maxTextLines)), 600);
        return entry;
    }

    private static string[] Behaviors(CollectibleObject collectible)
    {
        var names = (collectible.CollectibleBehaviors ?? []).Select(b => b.GetType().Name)
            .Concat(((collectible as Block)?.BlockBehaviors ?? []).Select(b => b.GetType().Name))
            .Select(name => name.StartsWith("CollectibleBehavior") ? name["CollectibleBehavior".Length..] : name.StartsWith("BlockBehavior") ? name["BlockBehavior".Length..] : name)
            .Where(name => name.Length > 0).Distinct().OrderBy(name => name, StringComparer.Ordinal).ToArray();
        return names;
    }

    // One creature as the game types it: its class, what it drops when killed.
    // Nothing about temperament; hostility is prior knowledge Node keeps.
    private static Dictionary<string, object?> Entry(EntityProperties type) => new()
    {
        ["code"] = type.Code.ToString(),
        ["type"] = "entity",
        ["name"] = ContextSensor.Clip(CreatureName(type), 96),
        ["class"] = type.Class,
        ["drops"] = Drops(type.Drops),
    };

    private static string CreatureName(EntityProperties type) => Lang.GetIfExists("item-creature-" + type.Code.Path) ?? type.Code.Path;

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
            return new { drops = Drops(harvestable.harvestedStacks), tool = harvestable.Tool?.ToString() };
        if (block.GetBehavior(typeof(BlockBehaviorFruitingBush), true) is BlockBehaviorFruitingBush bush && bush.harvestedStacks != null)
            // The bush's growth runs young, mature, flowering, ripening, ripe, dormant; berries come off a ripe bush.
            return new { drops = Drops(bush.harvestedStacks), requiresGrowth = "ripe" };
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
        }
        return text.ToString().Replace("\r", "").Split('\n').Select(line => line.Trim()).Where(line => line.Length > 0)
            .Take(80).Select(line => ContextSensor.Clip(line, 400)!).ToArray();
    }
}
