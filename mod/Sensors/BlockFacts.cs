using System.Linq;
using Vintagestory.API.Common;
using Vintagestory.API.MathTools;
using Vintagestory.GameContent;

namespace VintageStoryAI;

// What a player can tell about a placed block by looking at it: its name,
// the variant states its code carries, and the growth state a fruiting plant
// shows by its model. No purpose labels; Node decides what a block is for.
internal static class BlockFacts
{
    public static object Observe(IWorldAccessor world, BlockPos pos, Block block)
    {
        string? growth = null;
        if (block.HasBehavior<BlockBehaviorFruitingBush>(true))
        {
            var entity = world.BlockAccessor.GetBlockEntity(pos);
            var bush = entity?.GetBehavior<BEBehaviorFruitingBush>();
            // The game's growth states: young, mature, flowering, ripening, ripe, dormant; berries come off a ripe bush.
            growth = bush?.BState.Growthstate.ToString().ToLowerInvariant();


        }
        return new
        {
            name = ContextSensor.Clip(block.GetPlacedBlockName(world, pos), 96),
            variant = block.VariantStrict.ToDictionary(pair => pair.Key, pair => pair.Value), growth
        };
    }
}
