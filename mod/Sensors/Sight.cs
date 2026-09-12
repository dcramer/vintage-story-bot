using Vintagestory.API.Client;
using Vintagestory.API.Common;
using Vintagestory.API.MathTools;
using Vintagestory.Client.NoObf;

namespace VintageStoryAI;

// What one line of sight can tell about a block, shared by every sensor:
// whether a cell stops the eye, whether a block is the bulk terrain a column
// already stands for, whether it is big enough to make out from here, and the
// point a ray is aimed at. Facts of shape and material only, never purpose:
// the eye reports everything it can make out and Node decides what matters.
internal static class Sight
{
    public static bool Occludes(IBlockAccessor blocks, BlockPos at, Block block) =>
        block.BlockMaterial is not (EnumBlockMaterial.Plant or EnumBlockMaterial.Leaves) || block.LightAbsorption > 1 ||
        (block.GetCollisionBoxes(blocks, at)?.Length ?? 0) != 0;

    public static string BlockKey(BlockPos pos, Block block) => $"block:{pos.dimension}:{pos.X}:{pos.Y}:{pos.Z}:{block.Code}";

    // Bulk terrain: what the ground is made of (soil, rock, sand, gravel, snow,
    // ice, mantle) when it is something to stand on, water, lava, the leaves of a
    // canopy and the grass that covers ground. A surface column already says
    // what it is made of; a loose stone or a flint resting on it is a thing
    // in its own right, so material alone never makes a block bulk.
    public static bool Bulk(IBlockAccessor blocks, BlockPos pos, Block block)
    {
        if (block.Id == 0) return true;
        switch (block.BlockMaterial)
        {
            case EnumBlockMaterial.Air: case EnumBlockMaterial.Water: case EnumBlockMaterial.Lava: case EnumBlockMaterial.Leaves:
                return true;
            case EnumBlockMaterial.Soil: case EnumBlockMaterial.Gravel: case EnumBlockMaterial.Sand: case EnumBlockMaterial.Stone:
            case EnumBlockMaterial.Snow: case EnumBlockMaterial.Ice: case EnumBlockMaterial.Mantle:
                return (block.GetCollisionBoxes(blocks, pos)?.Length ?? 0) > 0;
            default:
                return block.Code?.Path.StartsWith("tallgrass", StringComparison.Ordinal) == true;
        }
    }

    // Where the eye aims at a block and how big the block is: its first
    // selection box, or the whole cell when it has none.
    public static (Point3 Point, double Size) Aim(IBlockAccessor blocks, BlockPos pos, Block block)
    {
        var box = (block.GetSelectionBoxes(blocks, pos) ?? []).FirstOrDefault();
        if (box == null) return (new(pos.X + .5, pos.Y + .5, pos.Z + .5), 1);
        var min = new Point3(pos.X + box.X1, pos.Y + box.Y1, pos.Z + box.Z1);
        var max = new Point3(pos.X + box.X2, pos.Y + box.Y2, pos.Z + box.Z2);
        return (SceneGeometry.BoxSamples(min, max).First(), SceneGeometry.Size(min, max));
    }

    // What the server lets this player do with a block, as the client already knows it.
    public static object? Access(ICoreClientAPI api, BlockPos pos)
    {
        if (api.World is not ClientMain client) return null;
        return new
        {
            buildOrBreak = client.WorldMap.TestAccess(api.World.Player, pos, EnumBlockAccessFlags.BuildOrBreak) == EnumWorldAccessResponse.Granted,
            use = client.WorldMap.TestAccess(api.World.Player, pos, EnumBlockAccessFlags.Use) == EnumWorldAccessResponse.Granted
        };
    }

    // One block sighting as the eye reports it: what a player can tell by looking at it.
    public static object Extra(ICoreClientAPI api, BlockPos pos, Block block) =>
        new { facts = BlockFacts.Observe(api.World, pos, block), access = Access(api, pos) };
}
