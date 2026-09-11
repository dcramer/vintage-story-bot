using Vintagestory.API.Common;
using Vintagestory.API.MathTools;
using Vintagestory.GameContent;

namespace VintageStoryAI;

internal static class ForageSensor
{
    // Call only after scene LOS validation or for the native crosshair selection.
    // Expose the visible growth stage, not soil nutrients, traits or future timers.
    public static object? Observe(IBlockAccessor blocks, BlockPos pos, Block block)
    {
        if (block.Code.Domain != "game") return null;
        if (block.Code.Path.StartsWith("fruitingbush-"))
        {
            var bush = blocks.GetBlockEntity(pos)?.GetBehavior<BEBehaviorFruitingBush>();
            if (bush == null) return null;
            return new { kind = "berries", stage = bush.BState.Growthstate.ToString().ToLowerInvariant(),
                ripe = bush.BState.Growthstate == EnumFruitingBushGrowthState.Ripe,
                foodCode = $"game:fruit-{block.Variant["type"]}" };
        }
        if (block.Code.Path.StartsWith("smallberrybush-") || block.Code.Path.StartsWith("bigberrybush-"))
            return new { kind = "berries", stage = block.Variant["state"],
                ripe = block.Variant["state"] == "ripe", foodCode = $"game:fruit-{block.Variant["type"]}" };
        return null;
    }
}
