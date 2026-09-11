using System.Diagnostics;
using Vintagestory.API.Client;
using Vintagestory.API.Common;
using Vintagestory.API.MathTools;

namespace VintageStoryAI;

internal sealed class SceneSensor(ICoreClientAPI api, Func<bool> canControl)
{
    private sealed record Candidate(string Kind, string Key, string Code, Point3 Point, BlockPos? Block, int? Quantity);
    private sealed class ScanJob(Point3 eye, double yaw, double pitch, int radius, int limit, string kind, string[] matches)
    {
        public readonly string Id = Guid.NewGuid().ToString("N");
        public readonly long Started = Environment.TickCount64;
        public readonly Point3 Eye = eye;
        public readonly double Yaw = yaw, Pitch = pitch;
        public readonly int Radius = radius, Limit = limit, Side = radius * 2 + 1;
        public readonly string Kind = kind;
        public readonly string[] Matches = matches;
        public readonly Queue<Candidate> Pending = new();
        public readonly HashSet<string> Seen = [];
        public int Index;
        public bool Incomplete;
        public int Total => Kind is "items" or "entities" ? 0 : Side * Side * Side;
    }
    private readonly Dictionary<string, ScanJob> jobs = new();
    public void Reset() => jobs.Clear();

    public object Scan(int radius, int limit, string kind, string[] matches, string? cursor = null)
    {
        if (!canControl())
            return new { ok = false, error = "Close menus and unpause before scanning." };
        var watch = Stopwatch.StartNew();
        var player = api.World.Player.Entity;
        // First version explicitly limits dimensional/ray semantics to the normal world.
        if (player.Pos.Dimension != 0)
            return new { ok = false, error = "Scene scanning currently supports dimension 0 only." };
        var current = player.Pos.XYZ.Add(player.LocalEyePos);
        var currentEye = new Point3(current.X, current.Y, current.Z);
        var client = api.World as Vintagestory.Client.NoObf.ClientMain;
        double yaw = SceneGeometry.Normalize(player.Pos.Yaw * 180 / Math.PI);
        double pitch = (player.Pos.Pitch - Math.PI) * 180 / Math.PI;
        var blocks = api.World.BlockAccessor;
        foreach (var id in jobs.Where(pair => Environment.TickCount64 - pair.Value.Started > 30000).Select(pair => pair.Key).ToArray()) jobs.Remove(id);
        ScanJob job;
        if (cursor != null)
        {
            if (!jobs.TryGetValue(cursor, out job!) || job.Radius != radius || job.Limit != limit || job.Kind != kind ||
                !job.Matches.SequenceEqual(matches) ||
                SceneGeometry.Distance(job.Eye, currentEye) > 2 || radius > 8 &&
                (Math.Abs(SceneGeometry.Normalize(job.Yaw - yaw + 180) - 180) > 15 || Math.Abs(job.Pitch - pitch) > 15))
            {
                jobs.Remove(cursor);
                return new { ok = false, code = "scan_expired", error = "Scan expired or viewpoint changed; start a fresh scan." };
            }
        }
        else
        {
            while (jobs.Count >= 4) jobs.Remove(jobs.Keys.First());
            job = new ScanJob(currentEye, yaw, pitch, radius, limit, kind, matches);
            jobs.Add(job.Id, job);
        }
        var eye = job.Eye;
        var origin = new Vec3d(eye.X, eye.Y, eye.Z);
        bool Matches(string code) => matches.Length == 0 || matches.Any(match => code.Contains(match, StringComparison.OrdinalIgnoreCase));
        bool InView(Point3 point) => SceneGeometry.Distance(eye, point) <= Math.Min(8, radius) ||
            SceneGeometry.InCone(eye, point, job.Yaw, job.Pitch, radius);

        if (cursor == null && kind is "all" or "items" or "entities")
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
                if (InView(point)) job.Pending.Enqueue(new(item ? "item" : "entity", $"entity:{entity.EntityId}", code, point, null, stack?.StackSize));
                if (job.Pending.Count >= 1024) { job.Incomplete = true; break; }
            }
        }

        var found = new List<object>();
        int rays = 0, cells = 0;
        // Yield between pages, including empty terrain; distant searches never scan a whole volume in one tick.
        while (watch.ElapsedMilliseconds < 12 && rays < 128 && cells < 32768 && found.Count < limit)
        {
            if (job.Pending.Count == 0)
            {
                if (job.Index >= job.Total) break;
                int index = job.Index++, side = job.Side;
                int x = (int)Math.Floor(eye.X) - radius + index / (side * side);
                int y = (int)Math.Floor(eye.Y) - radius + index / side % side;
                int z = (int)Math.Floor(eye.Z) - radius + index % side;
                cells++;
                if (SceneGeometry.Distance(eye, new(x + .5, y + .5, z + .5)) > radius + 1) continue;
                var pos = new BlockPos(x, y, z, 0);
                if (blocks.GetChunkAtBlockPos(pos) == null) { job.Incomplete = true; continue; }
                var block = blocks.GetBlock(pos);
                if (block.Id == 0 || block.Code == null || !Matches(block.Code.ToString())) continue;
                foreach (var box in (block.GetSelectionBoxes(blocks, pos) ?? []).Take(4))
                    foreach (var point in SceneGeometry.BoxSamples(new(x + box.X1, y + box.Y1, z + box.Z1), new(x + box.X2, y + box.Y2, z + box.Z2)))
                        if (InView(point)) job.Pending.Enqueue(new("block", BlockKey(pos, block), block.Code.ToString(), point, pos, null));
                continue;
            }
            var candidate = job.Pending.Dequeue();
            if (job.Seen.Contains(candidate.Key)) continue;
            if (candidate.Block != null && blocks.GetBlock(candidate.Block).Code?.ToString() != candidate.Code) continue;
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
                if (blocks.GetChunkAtBlockPos(pos) == null) { loaded = false; job.Incomplete = true; break; }
            }
            if (!loaded) continue;
            BlockSelection? blockHit = null;
            EntitySelection? entityHit = null;
            api.World.RayTraceForSelection(origin, end, ref blockHit, ref entityHit,
                (at, b) => candidate.Block?.Equals(at) == true || Occludes(blocks, at, b), _ => false);
            bool clear = candidate.Block == null ? blockHit == null : blockHit?.Position.Equals(candidate.Block) == true;
            if (!clear) continue;
            var look = SceneGeometry.LookAt(eye, candidate.Point);
            job.Seen.Add(candidate.Key);
            found.Add(new
            {
                kind = candidate.Kind, key = candidate.Key, code = candidate.Code,
                point = new { x = candidate.Point.X, y = candidate.Point.Y, z = candidate.Point.Z },
                distance = Math.Round(distance, 2), quantity = candidate.Quantity,
                access = candidate.Block == null || client == null ? null : new
                {
                    buildOrBreak = client.WorldMap.TestAccess(api.World.Player, candidate.Block, EnumBlockAccessFlags.BuildOrBreak) == EnumWorldAccessResponse.Granted,
                    use = client.WorldMap.TestAccess(api.World.Player, candidate.Block, EnumBlockAccessFlags.Use) == EnumWorldAccessResponse.Granted
                },
                forage = candidate.Block == null ? null : ForageSensor.Observe(blocks, candidate.Block, blocks.GetBlock(candidate.Block)),
                source = distance <= Math.Min(8, radius) ? "nearby" : "sight",
                withinPickingRange = distance <= api.World.Player.WorldData.PickingRange,
                look = new { yawDegrees = Math.Round(look.Yaw, 3), pitchDegrees = Math.Clamp(Math.Round(look.Pitch, 3), -89, 89) }
            });
        }
        bool more = job.Index < job.Total || job.Pending.Count > 0;
        if (job.Seen.Count >= 4096) { more = false; job.Incomplete = true; }
        if (!more) jobs.Remove(job.Id);
        return new
        {
            ok = true, observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), dimension = 0,
            visibility = "360-degree nearby awareness within 8 blocks; 120x90-degree distant sight; sampled occlusion, not pixels",
            origin = new { x = eye.X, y = eye.Y, z = eye.Z },
            radius, more, cursor = more ? job.Id : null, incomplete = more || job.Incomplete,
            elapsedMs = watch.ElapsedMilliseconds, objects = found
        };
    }

    public static string BlockKey(BlockPos pos, Block block) => $"block:{pos.dimension}:{pos.X}:{pos.Y}:{pos.Z}:{block.Code}";
    public static bool Occludes(IBlockAccessor blocks, BlockPos at, Block block) =>
        block.BlockMaterial is not (EnumBlockMaterial.Plant or EnumBlockMaterial.Leaves) || block.LightAbsorption > 1 ||
        (block.GetCollisionBoxes(blocks, at)?.Length ?? 0) != 0;
}
