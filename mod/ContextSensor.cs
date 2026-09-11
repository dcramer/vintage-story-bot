using Vintagestory.API.Client;
using Vintagestory.API.Common;
using Vintagestory.API.Datastructures;

namespace VintageStoryAI;

internal sealed class ContextSensor(ICoreClientAPI api)
{
    private static double? Number(ITreeAttribute? tree, string key)
    {
        var value = tree?[key]?.GetValue();
        double? number = value switch { float f => f, double d => d, int i => i, long l => l, _ => null };
        return number is { } n && double.IsFinite(n) ? n : null;
    }

    public object Condition()
    {
        var entity = api.World.Player.Entity;
        var attributes = entity.WatchedAttributes;
        var hunger = attributes.GetTreeAttribute("hunger");
        var tiredness = attributes.GetTreeAttribute("tiredness");
        return new
        {
            onFire = entity.IsOnFire,
            bodyTemperatureC = Number(attributes.GetTreeAttribute("bodyTemp"), "bodytemp"),
            wetness = Number(attributes, "wetness"), freezing = Number(attributes, "freezingEffectStrength"),
            temporalStability = Number(attributes, "temporalStability"),
            tiredness = Number(tiredness, "tiredness"),
            sleeping = Number(tiredness, "isSleeping") is { } sleep ? (bool?)(sleep != 0) : null,
            intoxication = Number(attributes, "intoxication"),
            nutrition = new { fruit = Number(hunger, "fruitLevel"), vegetable = Number(hunger, "vegetableLevel"),
                protein = Number(hunger, "proteinLevel"), grain = Number(hunger, "grainLevel"), dairy = Number(hunger, "dairyLevel") }
        };
    }

    public object Environment(string session)
    {
        var entity = api.World.Player.Entity;
        var pos = entity.Pos.AsBlockPos;
        var blocks = api.World.BlockAccessor;
        var calendar = api.World.Calendar;
        bool loaded = pos.dimension == 0 && blocks.GetChunkAtBlockPos(pos) != null;
        var climate = loaded ? blocks.GetClimateAt(pos, EnumGetClimateMode.NowValues) : null;
        var wind = loaded ? blocks.GetWindSpeedAt(pos) : null;
        return new
        {
            ok = true, observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), session,
            position = new { x = pos.X, y = pos.Y, z = pos.Z, dimension = pos.dimension },
            calendar = new { year = calendar.Year, dayOfYear = calendar.DayOfYear, hourOfDay = calendar.HourOfDay,
                totalDays = calendar.TotalDays, hoursPerDay = calendar.HoursPerDay, daysPerYear = calendar.DaysPerYear,
                season = loaded ? calendar.GetSeason(pos).ToString() : null,
                daylight = calendar.DayLightStrength, moonlight = calendar.MoonLightStrength, dusk = calendar.Dusk },
            climate = climate == null ? null : new { temperatureC = climate.Temperature,
                worldgenTemperatureC = climate.WorldGenTemperature, precipitation = climate.Rainfall,
                worldgenRainfall = climate.WorldgenRainfall, fertility = climate.Fertility,
                forestDensity = climate.ForestDensity, shrubDensity = climate.ShrubDensity,
                geologicActivity = climate.GeologicActivity, biomeId = climate.Biome },
            wind = wind == null ? null : new { x = wind.X, y = wind.Y, z = wind.Z },
            light = !loaded ? null : new { block = blocks.GetLightLevel(pos, EnumLightLevelType.OnlyBlockLight),
                sunlight = blocks.GetLightLevel(pos, EnumLightLevelType.TimeOfDaySunLight),
                maximum = blocks.GetLightLevel(pos, EnumLightLevelType.MaxTimeOfDayLight) },
            unavailable = !loaded ? "Local chunk unloaded or unsupported dimension." : climate == null ? "Local climate unavailable." : null
        };
    }

    public object InspectTarget(string session)
    {
        var player = api.World.Player;
        var selection = player.CurrentBlockSelection;
        if (selection != null)
        {
            var pos = selection.Position;
            if (api.World.BlockAccessor.GetChunkAtBlockPos(pos) == null)
                return new { ok = false, error = "Selected block unloaded." };
            var block = api.World.BlockAccessor.GetBlock(pos);
            return new
            {
                ok = true, observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), session,
                kind = "block", key = SceneSensor.BlockKey(pos, block), code = block.Code.ToString(),
                position = new { x = pos.X, y = pos.Y, z = pos.Z, dimension = pos.dimension },
                face = selection.Face?.Code, selectionBox = selection.SelectionBoxIndex,
                hit = new { x = pos.X + selection.HitPosition.X, y = pos.Y + selection.HitPosition.Y, z = pos.Z + selection.HitPosition.Z },
                material = block.GetBlockMaterial(api.World.BlockAccessor, pos).ToString(),
                resistance = block.GetResistance(api.World.BlockAccessor, pos), requiredMiningTier = block.GetRequiredMiningTier(api.World, pos),
                forage = ForageSensor.Observe(api.World.BlockAccessor, pos, block),
                info = Clip(block.GetPlacedBlockInfo(api.World, pos, player), 2048),
                interactionHints = Hints(block.GetPlacedBlockInteractionHelp(api.World, selection, player))
            };
        }
        var entitySelection = player.CurrentEntitySelection;
        var entity = entitySelection?.Entity;
        if (entity == null) return new { ok = true, target = (object?)null, session };
        return new
        {
            ok = true, observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), session,
            kind = "entity", key = $"entity:{entity.EntityId}", id = entity.EntityId, code = entity.Code?.ToString(),
            name = Clip(entity.GetName(), 160), alive = entity.Alive, onFire = entity.IsOnFire,
            position = new { x = entity.Pos.X, y = entity.Pos.Y, z = entity.Pos.Z, dimension = entity.Pos.Dimension },
            info = Clip(entity.GetInfoText(), 2048),
            interactionHints = Hints(entity.GetInteractionHelp(api.World, entitySelection, player))
        };
    }

    // Native HUD text/hints are untrusted descriptive data, not action authorization.
    private static string? Clip(string? value, int limit) => value == null ? null : value[..Math.Min(limit, value.Length)];
    private static object Hints(WorldInteraction[]? hints) => new
    {
        truncated = (hints?.Length ?? 0) > 16,
        entries = (hints ?? []).Take(16).Select(hint => new
        {
            action = Clip(hint.ActionLangCode, 160), mouseButton = hint.MouseButton.ToString(),
            hotkeys = hint.HotKeyCodes?.Take(4).Select(key => Clip(key, 64)).ToArray(),
            hotkey = Clip(hint.HotKeyCode, 64), requireFreeHand = hint.RequireFreeHand,
            exampleItems = hint.Itemstacks?.Take(8).Select(stack => Clip(stack.Collectible?.Code?.ToString(), 160)).ToArray(),
            itemsTruncated = (hint.Itemstacks?.Length ?? 0) > 8,
            conditional = hint.ShouldApply != null || hint.GetMatchingStacks != null
        }).ToArray()
    };
}
