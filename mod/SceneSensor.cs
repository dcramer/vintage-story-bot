using System.Diagnostics;
using Vintagestory.API.Client;
using Vintagestory.API.Common;
using Vintagestory.API.MathTools;

namespace VintageStoryAI;

internal sealed class SceneSensor(ICoreClientAPI api, Func<bool> canControl)
{
    private sealed record Candidate(string Kind, string Key, string Code, Point3 Point, BlockPos? Block, int? Quantity);

    public object Scan(int radius, int limit, string kind, string match)
    {
        if (!canControl())
            return new { ok = false, error = "Close menus and unpause before scanning." };
        var watch = Stopwatch.StartNew();
        var player = api.World.Player.Entity;
        // First version explicitly limits dimensional/ray semantics to the normal world.
        if (player.Pos.Dimension != 0)
            return new { ok = false, error = "Scene scanning currently supports dimension 0 only." };
        var origin = player.Pos.XYZ.Add(player.LocalEyePos);
        var eye = new Point3(origin.X, origin.Y, origin.Z);
        double yaw = SceneGeometry.Normalize(player.Pos.Yaw * 180 / Math.PI);
        double pitch = (player.Pos.Pitch - Math.PI) * 180 / Math.PI;
        var blocks = api.World.BlockAccessor;
        var candidates = new List<Candidate>();
        bool incomplete = false;
        bool Matches(string code) => code.Contains(match, StringComparison.OrdinalIgnoreCase);
        bool InView(Point3 point) => SceneGeometry.InCone(eye, point, yaw, pitch, radius);

        if (kind is "all" or "blocks")
        {
            int x0 = (int)Math.Floor(eye.X), y0 = (int)Math.Floor(eye.Y), z0 = (int)Math.Floor(eye.Z);
            for (int x = x0 - radius; x <= x0 + radius; x++)
            for (int y = y0 - radius; y <= y0 + radius; y++)
            for (int z = z0 - radius; z <= z0 + radius; z++)
            {
                var pos = new BlockPos(x, y, z, 0);
                if (blocks.GetChunkAtBlockPos(pos) == null) { incomplete = true; continue; }
                var block = blocks.GetBlock(pos);
                if (block.Id == 0 || block.Code == null || !Matches(block.Code.ToString())) continue;
                var boxes = block.GetSelectionBoxes(blocks, pos);
                if (boxes == null) continue;
                // Bound multi-box objects; a sample may miss partial visibility.
                foreach (var box in boxes.Take(4))
                {
                    // A ledge can hide a lower block's center while leaving its far top visible.
                    foreach (var point in SceneGeometry.BoxSamples(new(x + box.X1, y + box.Y1, z + box.Z1),
                        new(x + box.X2, y + box.Y2, z + box.Z2)))
                        if (InView(point)) candidates.Add(new("block", BlockKey(pos, block), block.Code.ToString(), point, pos, null));
                }
            }
        }

        if (kind is "all" or "items" or "entities")
        {
            foreach (var entity in api.World.GetEntitiesAround(origin, radius, radius))
            {
                if (entity.EntityId == player.EntityId || entity.Pos.Dimension != 0) continue;
                bool item = entity is EntityItem;
                if (kind == "items" && !item || kind == "entities" && item) continue;
                var stack = (entity as EntityItem)?.Itemstack;
                string? code = item ? stack?.Collectible?.Code?.ToString() : entity.Code?.ToString();
                if (code == null || !Matches(code)) continue;
                var box = entity.SelectionBox ?? entity.CollisionBox;
                var point = new Point3(entity.Pos.X, entity.Pos.Y + (box == null ? 0.1 : (box.Y1 + box.Y2) / 2), entity.Pos.Z);
                if (InView(point)) candidates.Add(new(item ? "item" : "entity", $"entity:{entity.EntityId}", code, point, null, stack?.StackSize));
            }
        }

        var found = new List<object>();
        var keys = new HashSet<string>();
        int rays = 0;
        foreach (var candidate in candidates.OrderBy(c => SceneGeometry.Distance(eye, c.Point)))
        {
            if (keys.Contains(candidate.Key)) continue;
            if (rays >= 256 || watch.ElapsedMilliseconds >= 40 || found.Count >= limit) { incomplete = true; break; }
            rays++;
            var end = new Vec3d(candidate.Point.X, candidate.Point.Y, candidate.Point.Z);
            double distance = SceneGeometry.Distance(eye, candidate.Point);
            // Never interpret an unloaded section of the sightline as empty air.
            bool loaded = true;
            for (int step = 0, steps = (int)Math.Ceiling(distance * 4); step <= steps; step++)
            {
                double t = steps == 0 ? 0 : (double)step / steps;
                var pos = new BlockPos((int)Math.Floor(origin.X + (end.X - origin.X) * t),
                    (int)Math.Floor(origin.Y + (end.Y - origin.Y) * t), (int)Math.Floor(origin.Z + (end.Z - origin.Z) * t), 0);
                if (blocks.GetChunkAtBlockPos(pos) == null) { loaded = false; incomplete = true; break; }
            }
            if (!loaded) continue;
            BlockSelection? blockHit = null;
            EntitySelection? entityHit = null;
            api.World.RayTraceForSelection(origin, end, ref blockHit, ref entityHit,
                (at, b) => candidate.Block?.Equals(at) == true || Occludes(blocks, at, b), _ => false);
            bool clear = candidate.Block == null ? blockHit == null : blockHit?.Position.Equals(candidate.Block) == true;
            if (!clear) continue;
            var look = SceneGeometry.LookAt(eye, candidate.Point);
            keys.Add(candidate.Key);
            found.Add(new
            {
                kind = candidate.Kind, key = candidate.Key, code = candidate.Code,
                point = new { x = candidate.Point.X, y = candidate.Point.Y, z = candidate.Point.Z },
                distance = Math.Round(distance, 2), quantity = candidate.Quantity,
                withinPickingRange = distance <= api.World.Player.WorldData.PickingRange,
                look = new { yawDegrees = Math.Round(look.Yaw, 3), pitchDegrees = Math.Clamp(Math.Round(look.Pitch, 3), -89, 89) }
            });
        }
        return new
        {
            ok = true, observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), dimension = 0,
            visibility = "120x90-degree cone + sampled block sightline; not pixel visibility",
            radius, incomplete, elapsedMs = watch.ElapsedMilliseconds, objects = found
        };
    }

    public static string BlockKey(BlockPos pos, Block block) => $"block:{pos.dimension}:{pos.X}:{pos.Y}:{pos.Z}:{block.Code}";
    public static bool Occludes(IBlockAccessor blocks, BlockPos at, Block block) =>
        block.BlockMaterial is not (EnumBlockMaterial.Plant or EnumBlockMaterial.Leaves) || block.LightAbsorption > 1 ||
        (block.GetCollisionBoxes(blocks, at)?.Length ?? 0) != 0;
}
