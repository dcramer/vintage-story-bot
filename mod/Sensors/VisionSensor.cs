using System.Diagnostics;
using Vintagestory.API.Client;
using Vintagestory.API.Common;
using Vintagestory.API.MathTools;
using Vintagestory.Client.NoObf;

namespace VintageStoryAI;

public readonly record struct Column(int X, int Z);

// Far-field surface memory as the mod holds it: what the camera has seen,
// published as deltas like TerrainMap. Rows carry the standing surface top
// and its kind; a null row forgets a column that expired or moved out of range.
public sealed class SurfaceMap(int capacity = 8192, long ttlMs = 300000, int radius = 96)
{
    private const long RefreshDeltaMs = 10_000;
    private sealed record Observation(double? Y, string? Kind, int Step, string? Code, long At, long Sequence, long PublishedAt);
    private readonly Dictionary<Column, Observation> columns = new();
    private long sequence, lostThrough;
    public string Session { get; private set; } = Guid.NewGuid().ToString("N");
    public int Count => columns.Count;
    public void Clear() { columns.Clear(); sequence = lostThrough = 0; Session = Guid.NewGuid().ToString("N"); }
    public bool Fresh(Column column, long now, long age) =>
        columns.TryGetValue(column, out var value) && value.Y != null && now - value.At <= Math.Min(age, ttlMs);
    public void Invalidate(Column column)
    {
        if (!columns.TryGetValue(column, out var prior) || prior.Y == null) return;
        long now = Environment.TickCount64;
        columns[column] = new(null, null, prior.Step, null, now, ++sequence, now);
        Bound();
    }
    public void Put(Column column, double y, string kind, int step, string? code, long now)
    {
        if (columns.TryGetValue(column, out var prior) && prior.Y != null && prior.Kind == kind &&
            Math.Abs(prior.Y.Value - y) < .001 && prior.Step == step)
        {
            bool publish = now - prior.PublishedAt >= RefreshDeltaMs;
            columns[column] = prior with { At = now, Sequence = publish ? ++sequence : prior.Sequence,
                PublishedAt = publish ? now : prior.PublishedAt };
        }
        else columns[column] = new(y, kind, step, code, now, ++sequence, now);
        Bound();
    }
    private void Bound()
    {
        if (columns.Count <= capacity) return;
        var oldest = columns.MinBy(pair => pair.Value.Sequence);
        lostThrough = Math.Max(lostThrough, oldest.Value.Sequence);
        columns.Remove(oldest.Key);
    }
    public void Prune(double x, double z, long now)
    {
        foreach (var (column, value) in columns.ToArray())
            if (value.Y != null && (now - value.At > ttlMs || Math.Abs(column.X - x) > radius || Math.Abs(column.Z - z) > radius))
                Invalidate(column);
    }
    public object Read(long after, string? session, long now)
    {
        bool reset = session != Session || after < lostThrough || after > sequence;
        if (reset) after = 0;
        var batch = columns.Where(p => p.Value.Sequence > after).OrderBy(p => p.Value.Sequence).Take(256).ToArray();
        long cursor = batch.Length == 0 ? sequence : batch[^1].Value.Sequence;
        return new { session = Session, reset, cursor, more = cursor < sequence, clock = now,
            columns = batch.Select(p => p.Value.Y == null
                ? new object?[] { p.Key.X, p.Key.Z, null }
                : new object?[] { p.Key.X, p.Key.Z, Math.Round(p.Value.Y.Value, 3), p.Value.Kind, p.Value.Step, p.Value.Code, p.Value.At }).ToArray() };
    }
}

// Passive far-field vision: every tick, while a controller is listening, sample
// surface columns inside the camera's real field of view and remember the ones
// a sightline reaches. Nothing is learned by asking; the head has to point
// there. Radius shrinks with darkness; nothing below the visible surface,
// behind a ridge or in an unloaded chunk is ever reported.
internal sealed class VisionSensor(ICoreClientAPI api, SurfaceMap map)
{
    private readonly Queue<Column> pending = new();
    private long nextBatch, nextPrune;
    private double batchYaw = double.NaN, batchPitch;
    private Cell? batchPosition;

    public void Reset() { pending.Clear(); map.Clear(); nextBatch = 0; batchYaw = double.NaN; batchPosition = null; }

    // Absolute-aligned level of detail: every column within 16 blocks, even
    // coordinates to 32, multiples of four beyond, so views merge in Node.
    public static int Step(double distance) => distance <= 16 ? 1 : distance <= 32 ? 2 : 4;

    // Half-angles of the client's actual field of view: vertical from the
    // setting, horizontal from the window's aspect ratio.
    public (double Horizontal, double Vertical) HalfAngles()
    {
        double vertical = Math.Clamp(ClientSettings.FieldOfView, 30, 120) / 2.0;
        double aspect = api.Render.FrameHeight > 0 ? api.Render.FrameWidth / (double)api.Render.FrameHeight : 16 / 9.0;
        double horizontal = Math.Atan(Math.Tan(vertical * Math.PI / 180) * aspect) * 180 / Math.PI;
        return (horizontal, vertical);
    }

    // How far the eye can see: full 64 blocks in daylight, down to a torch's
    // reach in the dark. Light is what a player has, not a query.
    public int Radius(BlockPos eye)
    {
        double daylight = api.World.Calendar.DayLightStrength;
        double torch = api.World.BlockAccessor.GetChunkAtBlockPos(eye) == null ? 0
            : api.World.BlockAccessor.GetLightLevel(eye, EnumLightLevelType.OnlyBlockLight) / 32.0;
        return (int)Math.Clamp(Math.Round(64 * Math.Max(daylight, torch)), 12, 64);
    }

    public void Sample(long now)
    {
        var player = api.World.Player.Entity;
        if (player.Pos.Dimension != 0) { Reset(); return; }
        var pos = player.Pos;
        var eye = pos.XYZ.Add(player.LocalEyePos);
        var blocks = api.World.BlockAccessor;
        double yaw = SceneGeometry.Normalize(pos.Yaw * 180 / Math.PI), pitch = (pos.Pitch - Math.PI) * 180 / Math.PI;
        var position = new Cell((int)Math.Floor(pos.X), (int)Math.Floor(pos.Y), (int)Math.Floor(pos.Z));
        if (now >= nextPrune) { map.Prune(eye.X, eye.Z, now); nextPrune = now + 1000; }
        var (halfYaw, halfPitch) = HalfAngles();
        int radius = Radius(new BlockPos((int)Math.Floor(eye.X), (int)Math.Floor(eye.Y), (int)Math.Floor(eye.Z), 0));
        bool turned = double.IsNaN(batchYaw) || Math.Abs(SceneGeometry.Normalize(yaw - batchYaw + 180) - 180) > 10 ||
            Math.Abs(pitch - batchPitch) > 10 || position != batchPosition;
        if (turned || pending.Count == 0 && now >= nextBatch)
        {
            pending.Clear();
            batchYaw = yaw; batchPitch = pitch; batchPosition = position;
            int eyeX = (int)Math.Floor(eye.X), eyeZ = (int)Math.Floor(eye.Z);
            var candidates = new List<(Column Column, double Angle, double Distance)>();
            for (int x = eyeX - radius; x <= eyeX + radius; x++) for (int z = eyeZ - radius; z <= eyeZ + radius; z++)
            {
                double planar = Math.Sqrt(Math.Pow(x + .5 - eye.X, 2) + Math.Pow(z + .5 - eye.Z, 2));
                if (planar > radius) continue;
                int step = Step(planar);
                if (Math.Abs(x) % step != 0 || Math.Abs(z) % step != 0) continue;
                double bearing = SceneGeometry.Normalize(Math.Atan2(x + .5 - eye.X, z + .5 - eye.Z) * 180 / Math.PI);
                double angle = Math.Abs(SceneGeometry.Normalize(bearing - yaw + 180) - 180);
                if (planar > 8 && angle > halfYaw) continue;
                candidates.Add((new Column(x, z), angle, planar));
            }
            // Unseen or stale columns first, then the middle of the view, then near.
            foreach (var candidate in candidates.OrderBy(c => map.Fresh(c.Column, now, 2000) ? 1 : 0)
                .ThenBy(c => c.Angle).ThenBy(c => c.Distance)) pending.Enqueue(candidate.Column);
            nextBatch = now + 250;
        }
        var watch = Stopwatch.StartNew();
        var origin = new Vec3d(eye.X, eye.Y, eye.Z);
        var eyePoint = new Point3(eye.X, eye.Y, eye.Z);
        int rays = 0, inspected = 0;
        while (pending.TryDequeue(out var column))
        {
            if (++inspected > 512 || rays >= 64 || watch.ElapsedMilliseconds >= 2) { pending.Enqueue(column); break; }
            if (map.Fresh(column, now, 2000)) continue;
            int x = column.X, z = column.Z;
            if (blocks.GetMapChunkAtBlockPos(new BlockPos(x, 0, z, 0)) == null ||
                blocks.GetChunkAtBlockPos(new BlockPos(x, (int)eye.Y, z, 0)) == null) continue;
            // The rain map only says where to start looking down the column;
            // the descent stops at the first surface and the sightline decides.
            int top = Math.Min(blocks.GetRainMapHeightAt(x, z), (int)Math.Floor(eye.Y) + radius);
            string? kind = null, code = null; double surface = 0; BlockPos? target = null;
            bool canopy = false, loaded = true;
            for (int y = top; y >= Math.Max(0, top - 12); y--)
            {
                var cell = new BlockPos(x, y, z, 0);
                if (blocks.GetChunkAtBlockPos(cell) == null) { loaded = false; break; }
                var fluid = blocks.GetBlock(cell, BlockLayersAccess.Fluid);
                if (fluid.IsLiquid())
                {
                    kind = fluid.Code?.Path.Contains("lava") == true ? "hazard" : "water";
                    code = fluid.Code?.Path; surface = y + 1; target = cell; break;
                }
                var block = blocks.GetBlock(cell);
                var boxes = block.GetCollisionBoxes(blocks, cell);
                if (boxes is { Length: > 0 })
                {
                    kind = block.Code?.Path.Contains("fire") == true ? "hazard" : canopy ? "canopy" : "ground";
                    code = block.Code?.Path; surface = y + boxes.Max(b => b.Y2); target = cell; break;
                }
                if (block.Id != 0 && block.BlockMaterial == EnumBlockMaterial.Leaves) canopy = true;
            }
            if (!loaded || kind == null || target == null) continue;
            var point = new Point3(x + .5, surface - .01, z + .5);
            double distance = SceneGeometry.Distance(eyePoint, point);
            if (distance > radius + 1) continue;
            var look = SceneGeometry.LookAt(eyePoint, point);
            if (distance > 8 && Math.Abs(look.Pitch - pitch) > halfPitch) continue;
            rays++;
            var end = new Vec3d(point.X, point.Y, point.Z);
            bool sightLoaded = true;
            for (int i = 0, n = (int)Math.Ceiling(distance * 2); i <= n; i++)
            {
                double t = n == 0 ? 0 : (double)i / n;
                var along = new BlockPos((int)Math.Floor(origin.X + (end.X - origin.X) * t),
                    (int)Math.Floor(origin.Y + (end.Y - origin.Y) * t), (int)Math.Floor(origin.Z + (end.Z - origin.Z) * t), 0);
                if (blocks.GetChunkAtBlockPos(along) == null) { sightLoaded = false; break; }
            }
            if (!sightLoaded) continue;
            BlockSelection? hit = null; EntitySelection? entityHit = null;
            api.World.RayTraceForSelection(origin, end, ref hit, ref entityHit,
                (at, b) => at.Equals(target) || SceneSensor.Occludes(blocks, at, b), _ => false);
            if (hit != null && !hit.Position.Equals(target)) continue;
            map.Put(column, surface, kind, Step(Math.Sqrt(Math.Pow(x + .5 - eye.X, 2) + Math.Pow(z + .5 - eye.Z, 2))), code, now);
        }
    }
}
