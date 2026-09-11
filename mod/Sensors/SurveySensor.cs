using System.Diagnostics;
using Vintagestory.API.Client;
using Vintagestory.API.Common;
using Vintagestory.API.MathTools;

namespace VintageStoryAI;

// Long-range surface survey: the landscape a player sees when looking toward a
// destination. One sight-verified surface sample per column, coarser with
// distance. Nothing under the visible surface, behind a ridge or beyond the
// forward cone is reported; unloaded or occluded columns are simply absent.
internal sealed class SurveySensor(ICoreClientAPI api, Func<bool> canControl)
{
    private sealed class SurveyJob(Point3 eye, double yaw, double pitch, int radius)
    {
        public readonly string Id = Guid.NewGuid().ToString("N");
        public readonly long Started = Environment.TickCount64;
        public readonly Point3 Eye = eye;
        public readonly double Yaw = yaw, Pitch = pitch;
        public readonly int Radius = radius, Side = radius * 2 + 1;
        public int Index;
        public bool Incomplete;
        public int Total => Side * Side;
    }
    private readonly Dictionary<string, SurveyJob> jobs = new();
    public void Reset() => jobs.Clear();

    // Absolute-aligned level of detail: every column within 16 blocks, even
    // coordinates to 32, multiples of four beyond. Alignment to world
    // coordinates lets surveys from different viewpoints merge into one map.
    public static int Step(double distance) => distance <= 16 ? 1 : distance <= 32 ? 2 : 4;

    public object Survey(int radius, string? cursor = null)
    {
        if (!canControl())
            return new { ok = false, error = "Close menus and unpause before surveying." };
        var watch = Stopwatch.StartNew();
        var player = api.World.Player.Entity;
        if (player.Pos.Dimension != 0)
            return new { ok = false, error = "Surface survey supports dimension 0 only." };
        var current = player.Pos.XYZ.Add(player.LocalEyePos);
        var currentEye = new Point3(current.X, current.Y, current.Z);
        double yaw = SceneGeometry.Normalize(player.Pos.Yaw * 180 / Math.PI);
        double pitch = (player.Pos.Pitch - Math.PI) * 180 / Math.PI;
        var blocks = api.World.BlockAccessor;
        foreach (var id in jobs.Where(pair => Environment.TickCount64 - pair.Value.Started > 30000).Select(pair => pair.Key).ToArray()) jobs.Remove(id);
        SurveyJob job;
        if (cursor != null)
        {
            if (!jobs.TryGetValue(cursor, out job!) || job.Radius != radius ||
                SceneGeometry.Distance(job.Eye, currentEye) > 2 ||
                Math.Abs(SceneGeometry.Normalize(job.Yaw - yaw + 180) - 180) > 15 || Math.Abs(job.Pitch - pitch) > 15)
            {
                jobs.Remove(cursor);
                return new { ok = false, code = "survey_expired", error = "Survey expired or viewpoint changed; start a fresh survey." };
            }
        }
        else
        {
            while (jobs.Count >= 2) jobs.Remove(jobs.Keys.First());
            job = new SurveyJob(currentEye, yaw, pitch, radius);
            jobs.Add(job.Id, job);
        }
        var eye = job.Eye;
        var origin = new Vec3d(eye.X, eye.Y, eye.Z);
        int eyeX = (int)Math.Floor(eye.X), eyeZ = (int)Math.Floor(eye.Z);
        var columns = new List<object>();
        int rays = 0, cells = 0;
        while (watch.ElapsedMilliseconds < 12 && rays < 128 && cells < 8192 && job.Index < job.Total)
        {
            int index = job.Index++, side = job.Side;
            int x = eyeX - radius + index / side, z = eyeZ - radius + index % side;
            cells++;
            double planar = Math.Sqrt(Math.Pow(x + .5 - eye.X, 2) + Math.Pow(z + .5 - eye.Z, 2));
            if (planar > radius) continue;
            int step = Step(planar);
            if (Math.Abs(x) % step != 0 || Math.Abs(z) % step != 0) continue;
            var column = new BlockPos(x, 0, z, 0);
            if (blocks.GetMapChunkAtBlockPos(column) == null || blocks.GetChunkAtBlockPos(new BlockPos(x, (int)eye.Y, z, 0)) == null)
            { job.Incomplete = true; continue; }
            // The rain map is only a starting height: the descent below stops
            // at the first visible surface, and the sightline decides whether
            // the player can actually see it from here.
            int top = Math.Min(blocks.GetRainMapHeightAt(x, z), (int)Math.Floor(eye.Y) + radius);
            string? kind = null, code = null; double surface = 0; BlockPos? target = null;
            bool canopy = false, loaded = true;
            for (int y = top; y >= Math.Max(0, top - 12); y--)
            {
                var pos = new BlockPos(x, y, z, 0);
                if (blocks.GetChunkAtBlockPos(pos) == null) { loaded = false; break; }
                var fluid = blocks.GetBlock(pos, BlockLayersAccess.Fluid);
                if (fluid.IsLiquid())
                {
                    kind = fluid.Code?.Path.Contains("lava") == true ? "hazard" : "water";
                    code = fluid.Code?.Path; surface = y + 1; target = pos; break;
                }
                var block = blocks.GetBlock(pos);
                var boxes = block.GetCollisionBoxes(blocks, pos);
                if (boxes is { Length: > 0 })
                {
                    kind = block.Code?.Path.Contains("fire") == true ? "hazard" : canopy ? "canopy" : "ground";
                    code = block.Code?.Path; surface = y + boxes.Max(b => b.Y2); target = pos; break;
                }
                if (block.Id != 0 && block.BlockMaterial == EnumBlockMaterial.Leaves) canopy = true;
            }
            if (!loaded) { job.Incomplete = true; continue; }
            if (kind == null || target == null) continue;
            var point = new Point3(x + .5, surface - .01, z + .5);
            double distance = SceneGeometry.Distance(eye, point);
            if (distance > 8 && !SceneGeometry.InCone(eye, point, job.Yaw, job.Pitch, radius + 1)) continue;
            if (distance > radius + 1) continue;
            rays++;
            var end = new Vec3d(point.X, point.Y, point.Z);
            bool sightLoaded = true;
            for (int i = 0, n = (int)Math.Ceiling(distance * 2); i <= n; i++)
            {
                double t = n == 0 ? 0 : (double)i / n;
                var pos = new BlockPos((int)Math.Floor(origin.X + (end.X - origin.X) * t),
                    (int)Math.Floor(origin.Y + (end.Y - origin.Y) * t), (int)Math.Floor(origin.Z + (end.Z - origin.Z) * t), 0);
                if (blocks.GetChunkAtBlockPos(pos) == null) { sightLoaded = false; break; }
            }
            if (!sightLoaded) { job.Incomplete = true; continue; }
            BlockSelection? hit = null; EntitySelection? entityHit = null;
            api.World.RayTraceForSelection(origin, end, ref hit, ref entityHit,
                (at, b) => at.Equals(target) || SceneSensor.Occludes(blocks, at, b), _ => false);
            if (hit != null && !hit.Position.Equals(target)) continue;
            columns.Add(new object?[] { x, z, Math.Round(surface, 3), kind, step, code });
        }
        bool more = job.Index < job.Total;
        if (!more) jobs.Remove(job.Id);
        return new
        {
            ok = true, observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), dimension = 0,
            origin = new { x = eye.X, y = eye.Y, z = eye.Z }, yawDegrees = Math.Round(job.Yaw, 2), radius,
            more, cursor = more ? job.Id : null, incomplete = more || job.Incomplete,
            elapsedMs = watch.ElapsedMilliseconds, columns
        };
    }
}
