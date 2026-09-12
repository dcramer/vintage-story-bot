using System.Diagnostics;
using Vintagestory.API.Client;
using Vintagestory.API.Common;
using Vintagestory.API.Common.Entities;
using Vintagestory.API.MathTools;

namespace VintageStoryAI;

// The surroundings: every cell within eight blocks, in every direction, that a
// line of sight from the eye reaches. Each is reported with its shape, its
// trait words and its code; a block that is not bulk terrain is also a
// sighting with its facts, so what is around the body is known without
// looking for it by name.
internal sealed class TerrainSensor(ICoreClientAPI api, TerrainMap map, SightingsMap sightings)
{
    private readonly Queue<Cell> pending = new();
    private long nextBatch, nextPrune;
    private Cell? lastPosition;
    private Cell? lastPriority;
    public void Reset() { pending.Clear(); map.Clear(); nextBatch = 0; lastPosition = lastPriority = null; }
    public void Changed(BlockPos pos, Block oldBlock)
    {
        // The changed cell is unknown until observed again. Neighbor-dependent
        // shapes (doors/fences) become stale and are resampled promptly without
        // making an otherwise unchanged local route disappear in the meantime.
        for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++)
        {
            var cell = new Cell(pos.X + x, pos.Y + y, pos.Z + z);
            if (x == 0 && y == 0 && z == 0) map.Invalidate(cell);
            else map.Stale(cell);
        }
        // Only a change near the body restarts the sweep; a far one (water flowing, another player
        // building) is merely remembered as unknown until the disk reaches it again.
        var body = api.World?.Player?.Entity?.Pos;
        if (body != null && (Math.Abs(pos.X + .5 - body.X) > 10 || Math.Abs(pos.Y + .5 - body.Y) > 10 || Math.Abs(pos.Z + .5 - body.Z) > 10)) return;
        pending.Clear();
        nextBatch = 0;
    }
    private static long RefreshMs(Cell cell, EntityPos pos) =>
        SceneGeometry.Square(cell.X + .5 - pos.X) + SceneGeometry.Square(cell.Z + .5 - pos.Z) <= 16 ? 500 : 1500;
    public void Sample(long now, Cell? priority = null)
    {
        var player = api.World.Player.Entity;
        if (player.Pos.Dimension != 0) { Reset(); return; }
        var pos = player.Pos;
        if (priority != lastPriority) { pending.Clear(); nextBatch = 0; lastPriority = priority; }
        var position = new Cell((int)Math.Floor(pos.X), (int)Math.Floor(pos.Y), (int)Math.Floor(pos.Z));
        if (position != lastPosition)
        {
            pending.Clear(); nextBatch = 0; lastPosition = position;
        }
        var foot = new Point3(pos.X, pos.Y, pos.Z);
        var blocks = api.World.BlockAccessor;
        // Forgetting is a once-a-second sweep over the whole map, not a per-tick one.
        if (now >= nextPrune) { map.Prune(foot, now, cell => blocks.GetChunkAtBlockPos(cell.X, cell.Y, cell.Z) != null); nextPrune = now + 1000; }
        if (pending.Count == 0 && now >= nextBatch)
        {
            var cells = new List<Cell>();
            // The full eight-block surroundings disk, three blocks down and six up,
            // so a slope or ledge is observed before the player stands under it.
            // Cells within four blocks refresh twice a second, the rest every
            // 1.5 seconds; a low frame rate then still keeps the body path fresh.
            for (int x = -8; x <= 8; x++) for (int z = -8; z <= 8; z++) for (int y = -3; y <= 6; y++)
                if (x * x + z * z <= 64) cells.Add(new((int)Math.Floor(pos.X) + x, (int)Math.Floor(pos.Y) + y, (int)Math.Floor(pos.Z) + z));
            foreach (var cell in cells.OrderBy(c => c == priority ? 0 : map.Fresh(c, now, RefreshMs(c, pos)) ? 2 : 1)
                .ThenBy(c => SceneGeometry.Square(c.X + .5 - pos.X) + SceneGeometry.Square(c.Z + .5 - pos.Z))) pending.Enqueue(cell);
            nextBatch = now + 100;
        }
        var watch = Stopwatch.StartNew();
        var eye = pos.XYZ.Add(player.LocalEyePos);
        var origin = new Point3(eye.X, eye.Y, eye.Z);
        int rays = 0, inspected = 0;
        while (pending.TryDequeue(out var cell))
        {
            if (++inspected > 256 || rays >= 128 || watch.ElapsedMilliseconds >= 5) { pending.Enqueue(cell); break; }
            if (map.Fresh(cell, now, RefreshMs(cell, pos))) continue;
            var blockPos = new BlockPos(cell.X, cell.Y, cell.Z, 0);
            if (blocks.GetChunkAtBlockPos(blockPos) == null) { map.Invalidate(cell, "forgot"); continue; }
            var block = blocks.GetBlock(blockPos);
            var samples = SceneGeometry.BoxSamples(
                new(cell.X, cell.Y, cell.Z), new(cell.X + 1, cell.Y + 1, cell.Z + 1));
            bool visible = false;
            foreach (var target in samples)
            {
                if (SceneGeometry.Distance(origin, target) > 8) continue;
                if (++rays > 128) break;
                bool loaded = true;
                for (int i = 0, n = (int)Math.Ceiling(SceneGeometry.Distance(origin, target) * 4); i <= n; i++)
                {
                    double t = n == 0 ? 0 : (double)i / n;
                    if (blocks.GetChunkAtBlockPos((int)Math.Floor(eye.X + (target.X - eye.X) * t),
                        (int)Math.Floor(eye.Y + (target.Y - eye.Y) * t), (int)Math.Floor(eye.Z + (target.Z - eye.Z) * t)) == null) { loaded = false; break; }
                }
                if (!loaded) continue;
                BlockSelection? hit = null; EntitySelection? entityHit = null;
                // Selection boxes of translucent, non-colliding foliage are not opaque walls.
                api.World.RayTraceForSelection(eye, new Vec3d(target.X, target.Y, target.Z), ref hit, ref entityHit,
                    (at, b) => at.Equals(blockPos) || Sight.Occludes(blocks, at, b), _ => false);
                if (hit == null || hit.Position.Equals(blockPos)) { visible = true; break; }
            }
            if (!visible) continue;
            var boxes = block.GetCollisionBoxes(blocks, blockPos) ?? [];
            var fluid = blocks.GetBlock(blockPos, BlockLayersAccess.Fluid);
            // What a cell is, beyond its collision boxes, as words Node reasons with: which liquid fills it,
            // whether the solid is foliage (leaves, plants) or climbable, whether its shape overflows the cell,
            // and the mining tier a tool needs to break it. Facts only; Node decides what to do with them.
            var traits = new List<string>();
            string path = block.Code?.Path ?? "";
            if (path.Contains("fire") || path.Contains("lava") || fluid.Code?.Path.Contains("lava") == true) traits.Add(path.Contains("fire") ? "fire" : "lava");
            else if (fluid.IsLiquid()) traits.Add("water");
            if (path.Contains("leaves")) traits.Add("leaves");
            else if (block.BlockMaterial == EnumBlockMaterial.Plant) traits.Add("plant");
            if (block.Climbable) traits.Add("climbable");
            if (boxes.Length > 16 || boxes.Any(b => b.X1 < 0 || b.Y1 < 0 || b.Z1 < 0 || b.X2 > 1 || b.Y2 > 1 || b.Z2 > 1)) traits.Add("shape");
            int tier = boxes.Length > 0 ? block.GetRequiredMiningTier(api.World, blockPos) : 0;
            if (tier > 0) traits.Add($"tier{tier}");
            map.Put(cell, boxes.Take(16).Select(b => new Bounds(cell.X + b.X1, cell.Y + b.Y1, cell.Z + b.Z1,
                cell.X + b.X2, cell.Y + b.Y2, cell.Z + b.Z2)).ToArray(), traits.Count == 0 ? null : string.Join(",", traits), now,
                block.Id == 0 ? null : block.Code?.ToString());
            if (block.Id == 0 || block.Code == null || Sight.Bulk(blocks, blockPos, block)) continue;
            sightings.Put(Sight.BlockKey(blockPos, block), "block", block.Code.ToString(), Sight.Aim(blocks, blockPos, block).Point, "near",
                Sight.Extra(api, blockPos, block), now);
        }
    }
}
