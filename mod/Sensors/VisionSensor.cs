using System.Diagnostics;
using Vintagestory.API.Client;
using Vintagestory.API.Common;
using Vintagestory.API.Common.Entities;
using Vintagestory.API.MathTools;
using Vintagestory.Client.NoObf;

namespace VintageStoryAI;

public readonly record struct Column(int X, int Z);

// The eye's short-term buffer of far view surface columns. Not memory: a
// snapshot returns what has been confirmed in the last few seconds inside
// the current view, and Node remembers. CheckedAt drives resampling and
// attention changes; SeenAt drives what counts as seen right now.
public sealed class SurfaceMap(long ttlMs = 30000, int radius = 96)
{
    private sealed record Observation(double Y, string Kind, int Step, string? Code, int Color, long SeenAt, long CheckedAt);
    private readonly Dictionary<Column, Observation> columns = new();
    // Columns in the order they were last seen, so a snapshot walks only the
    // recent tail instead of every column the buffer holds.
    private readonly Queue<(Column Column, long SeenAt)> recent = new();
    public int Count => columns.Count;
    public void Clear() { columns.Clear(); recent.Clear(); }
    public bool Fresh(Column column, long now, long age) =>
        columns.TryGetValue(column, out var value) && now - value.CheckedAt <= age;
    public void Put(Column column, double y, string kind, int step, string? code, int color, long now)
    {
        columns[column] = new(y, kind, step, code, color, now, now);
        recent.Enqueue((column, now));
    }
    public void Prune(double x, double z, long now)
    {
        foreach (var (column, value) in columns.ToArray())
            if (now - value.SeenAt > ttlMs || Math.Abs(column.X - x) > radius || Math.Abs(column.Z - z) > radius) columns.Remove(column);
    }
    // What the eye sees now: columns inside the current view confirmed recently.
    public object[] Snapshot(long now, Point3 eye, double yaw, double halfYaw, long maxAgeMs = 5000)
    {
        while (recent.Count > 0 && now - recent.Peek().SeenAt > maxAgeMs) recent.Dequeue();
        var rows = new List<object?[]>(recent.Count);
        foreach (var (column, seenAt) in recent)
        {
            // A column seen again later is in the queue twice; only its latest sighting counts.
            if (!columns.TryGetValue(column, out var value) || value.SeenAt != seenAt) continue;
            double planar = Math.Sqrt(SceneGeometry.Square(column.X + .5 - eye.X) + SceneGeometry.Square(column.Z + .5 - eye.Z));
            if (planar > 8)
            {
                double bearing = SceneGeometry.Normalize(Math.Atan2(column.X + .5 - eye.X, column.Z + .5 - eye.Z) * 180 / Math.PI);
                if (Math.Abs(SceneGeometry.Normalize(bearing - yaw + 180) - 180) > halfYaw) continue;
            }
            rows.Add([column.X, column.Z, Math.Round(value.Y, 3), value.Kind, value.Step, value.Code, value.SeenAt, value.Color]);
        }
        return rows.ToArray();
    }
}

// Passive vision: every tick, while a controller is listening, sample surface
// columns, entities, ground items and the blocks standing on the visible
// surface inside the camera's real field of view, and report what a line of
// sight reaches. Nothing is learned by asking, and nothing has to be looked
// for by name: the head has to point there, and a thing has to be big enough
// to make out from that far (SceneGeometry.Resolves). Radius shrinks with
// darkness; nothing below the visible surface, behind a ridge or in an
// unloaded chunk is ever reported. Entities within 16 blocks are also
// reported as heard, the one approximation of a sense the client does not model.
internal sealed class VisionSensor(ICoreClientAPI api, SurfaceMap map, SightingsMap sightings)
{
    private const double HearingRange = 16;
    private const long TurnSettleMs = 150;
    private readonly Queue<Column> pending = new();
    private long nextBatch, nextPrune, lastTurnAt;
    private double batchYaw = double.NaN, batchPitch;
    private Cell? batchPosition;
    private bool sweeping, turning;
    private double viewYaw, viewHalfYaw;
    private Point3 viewEye;
    // Completed passes over the current view; Node waits for one after turning.
    public long Sweeps { get; private set; }
    // Block sightings one sweep may add: a bound on the page, rarely reached.
    private const int SweepBlocks = 512;
    private int sweepBlocks;

    public void Reset()
    {
        pending.Clear(); map.Clear(); sightings.Clear(); nextBatch = 0; batchYaw = double.NaN; batchPosition = null;
        Sweeps = 0; sweepBlocks = 0; sweeping = turning = false;
    }
    // What the eye sees right now, for one sense response; sightings since the reader's last look.
    public object Surface(long now) => new { sweeps = Sweeps, clock = now, columns = map.Snapshot(now, viewEye, viewYaw, viewHalfYaw) };
    public object Sightings(long now, long after = 0) => new { clock = now, sightings = sightings.Snapshot(now, after) };

    // Whether a line of sight from the eye reaches one cell right now: within 8
    // blocks in any direction, farther only inside the field of view and the
    // light-limited radius, and never through an unloaded stretch (unknown).
    public object CanSee(int x, int y, int z)
    {
        var player = api.World.Player.Entity;
        if (player.Pos.Dimension != 0) return new { ok = true, known = false, visible = false, reason = "dimension" };
        var pos = player.Pos;
        var eye = pos.XYZ.Add(player.LocalEyePos);
        var eyePoint = new Point3(eye.X, eye.Y, eye.Z);
        var blocks = api.World.BlockAccessor;
        var cell = new BlockPos(x, y, z, 0);
        if (blocks.GetChunkAtBlockPos(cell) == null) return new { ok = true, known = false, visible = false, reason = "unloaded" };
        var block = blocks.GetBlock(cell);
        var sample = block.Id == 0 ? new Point3(x + .5, y + .5, z + .5) : Sight.Aim(blocks, cell, block).Point;
        double distance = SceneGeometry.Distance(eyePoint, sample);
        var look = SceneGeometry.LookAt(eyePoint, sample);
        double yaw = SceneGeometry.Normalize(pos.Yaw * 180 / Math.PI), pitch = (pos.Pitch - Math.PI) * 180 / Math.PI;
        var (halfYaw, halfPitch) = HalfAngles();
        int radius = Radius(new BlockPos((int)Math.Floor(eye.X), (int)Math.Floor(eye.Y), (int)Math.Floor(eye.Z), 0));
        bool inView = distance <= 8 || (distance <= radius + 1 &&
            Math.Abs(SceneGeometry.Normalize(look.Yaw - yaw + 180) - 180) <= halfYaw && Math.Abs(look.Pitch - pitch) <= halfPitch);
        var summary = new { distance = Math.Round(distance, 2), code = block.Id == 0 ? null : block.Code?.ToString(), look = new { yawDegrees = look.Yaw, pitchDegrees = look.Pitch } };
        if (!inView) return new { ok = true, known = false, visible = false, reason = "outside_view", summary.distance, summary.code, summary.look };
        var origin = new Vec3d(eye.X, eye.Y, eye.Z);
        var end = new Vec3d(sample.X, sample.Y, sample.Z);
        for (int i = 0, n = (int)Math.Ceiling(distance * 2); i <= n; i++)
        {
            double t = n == 0 ? 0 : (double)i / n;
            if (blocks.GetChunkAtBlockPos((int)Math.Floor(origin.X + (end.X - origin.X) * t),
                (int)Math.Floor(origin.Y + (end.Y - origin.Y) * t), (int)Math.Floor(origin.Z + (end.Z - origin.Z) * t)) == null) return new { ok = true, known = false, visible = false, reason = "unloaded", summary.distance, summary.code, summary.look };
        }
        BlockSelection? hit = null; EntitySelection? entityHit = null;
        api.World.RayTraceForSelection(origin, end, ref hit, ref entityHit,
            (at, b) => at.Equals(cell) || Sight.Occludes(blocks, at, b), _ => false);
        bool visible = hit == null || hit.Position.Equals(cell);
        return new
        {
            ok = true, known = true, visible, summary.distance, summary.code, summary.look,
            blockedBy = visible || hit == null ? null : new { x = hit.Position.X, y = hit.Position.Y, z = hit.Position.Z },
        };
    }

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
        if (now >= nextPrune) { map.Prune(eye.X, eye.Z, now); sightings.Prune(now); nextPrune = now + 1000; }
        var (halfYaw, halfPitch) = HalfAngles();
        int radius = Radius(new BlockPos((int)Math.Floor(eye.X), (int)Math.Floor(eye.Y), (int)Math.Floor(eye.Z), 0));
        var eyePoint = new Point3(eye.X, eye.Y, eye.Z);
        var origin = new Vec3d(eye.X, eye.Y, eye.Z);
        viewEye = eyePoint; viewYaw = yaw; viewHalfYaw = halfYaw;
        SampleEntities(player, eyePoint, origin, yaw, pitch, halfYaw, halfPitch, radius, now);
        // A turning head sees a blur: wait until the camera has settled before
        // sweeping the new view. Walking only re-centres the sweep.
        bool turned = !double.IsNaN(batchYaw) && (Math.Abs(SceneGeometry.Normalize(yaw - batchYaw + 180) - 180) > 10 || Math.Abs(pitch - batchPitch) > 10);
        if (turned) { turning = true; lastTurnAt = now; batchYaw = yaw; batchPitch = pitch; }
        if (turning && now - lastTurnAt < TurnSettleMs) return;
        bool moved = position != batchPosition;
        if (double.IsNaN(batchYaw) || turning || moved || pending.Count == 0 && now >= nextBatch)
        {
            pending.Clear(); turning = false;
            batchYaw = yaw; batchPitch = pitch; batchPosition = position;
            int eyeX = (int)Math.Floor(eye.X), eyeZ = (int)Math.Floor(eye.Z);
            var candidates = new List<(Column Column, double Angle, double Distance)>();
            for (int x = eyeX - radius; x <= eyeX + radius; x++) for (int z = eyeZ - radius; z <= eyeZ + radius; z++)
            {
                double planar = Math.Sqrt(SceneGeometry.Square(x + .5 - eye.X) + SceneGeometry.Square(z + .5 - eye.Z));
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
            sweeping = pending.Count > 0; sweepBlocks = 0;
        }
        var watch = Stopwatch.StartNew();
        int rays = 0, inspected = 0;
        while (pending.TryDequeue(out var column))
        {
            if (++inspected > 512 || rays >= 64 || watch.ElapsedMilliseconds >= 2) { pending.Enqueue(column); break; }
            if (map.Fresh(column, now, 2000)) continue;
            int x = column.X, z = column.Z;
            if (blocks.GetMapChunkAtBlockPos(new BlockPos(x, 0, z, 0)) == null ||
                blocks.GetChunkAtBlockPos(new BlockPos(x, (int)eye.Y, z, 0)) == null) continue;
            // The rain map only says where to start looking down the column;
            // the descent stops at the first surface and the line of sight decides.
            int top = Math.Min(blocks.GetRainMapHeightAt(x, z), (int)Math.Floor(eye.Y) + radius);
            string? kind = null, code = null; double surface = 0; BlockPos? target = null; Block? surfaceBlock = null;
            bool canopy = false, loaded = true;
            for (int y = top; y >= Math.Max(0, top - 12); y--)
            {
                var cell = new BlockPos(x, y, z, 0);
                if (blocks.GetChunkAtBlockPos(cell) == null) { loaded = false; break; }
                var fluid = blocks.GetBlock(cell, BlockLayersAccess.Fluid);
                if (fluid.IsLiquid())
                {
                    kind = fluid.Code?.Path.Contains("lava") == true ? "hazard" : "water";
                    code = fluid.Code?.Path; surface = y + 1; target = cell; surfaceBlock = fluid; break;
                }
                var block = blocks.GetBlock(cell);
                var boxes = block.GetCollisionBoxes(blocks, cell);
                if (boxes is { Length: > 0 })
                {
                    kind = block.Code?.Path.Contains("fire") == true ? "hazard" : canopy ? "canopy" : "ground";
                    code = block.Code?.Path; surface = y + boxes.Max(b => b.Y2); target = cell; surfaceBlock = block; break;
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
                if (blocks.GetChunkAtBlockPos((int)Math.Floor(origin.X + (end.X - origin.X) * t),
                    (int)Math.Floor(origin.Y + (end.Y - origin.Y) * t), (int)Math.Floor(origin.Z + (end.Z - origin.Z) * t)) == null) { sightLoaded = false; break; }
            }
            if (!sightLoaded) continue;
            BlockSelection? hit = null; EntitySelection? entityHit = null;
            api.World.RayTraceForSelection(origin, end, ref hit, ref entityHit,
                (at, b) => at.Equals(target) || Sight.Occludes(blocks, at, b), _ => false);
            if (hit != null && !hit.Position.Equals(target)) continue;
            int mapColor = surfaceBlock!.GetColor(api, target);
            int rgb = ColorUtil.ColorR(mapColor) << 16 | ColorUtil.ColorG(mapColor) << 8 | ColorUtil.ColorB(mapColor);
            map.Put(column, surface, kind, Step(Math.Sqrt(SceneGeometry.Square(x + .5 - eye.X) + SceneGeometry.Square(z + .5 - eye.Z))), code, rgb, now);
            // What stands on or just around the visible surface: every block that is
            // not the bulk terrain the column already stands for and is big enough to
            // make out from here, each confirmed by its own line of sight. The
            // surroundings pass covers everything within eight blocks in every direction.
            if (distance <= 8) continue;
            for (int dy = -3; dy <= 3 && rays < 64 && sweepBlocks < SweepBlocks; dy++)
            {
                var cell = new BlockPos(x, target.Y + dy, z, 0);
                if (blocks.GetChunkAtBlockPos(cell) == null) continue;
                var block = blocks.GetBlock(cell);
                if (Sight.Bulk(blocks, cell, block)) continue;
                var (sample, size) = Sight.Aim(blocks, cell, block);
                double far = SceneGeometry.Distance(eyePoint, sample);
                if (far > radius + 1 || !SceneGeometry.Resolves(size, far)) continue;
                if (!cell.Equals(target))
                {
                    rays++;
                    BlockSelection? blockHit = null; EntitySelection? entitySeen = null;
                    api.World.RayTraceForSelection(origin, new Vec3d(sample.X, sample.Y, sample.Z), ref blockHit, ref entitySeen,
                        (at, b) => at.Equals(cell) || Sight.Occludes(blocks, at, b), _ => false);
                    if (blockHit != null && !blockHit.Position.Equals(cell)) continue;
                }
                sweepBlocks++;
                sightings.Put(Sight.BlockKey(cell, block), "block", block.Code!.ToString(), sample, "seen", Sight.Extra(api, cell, block), now);
            }
        }
        if (sweeping && pending.Count == 0) { sweeping = false; Sweeps++; }
    }

    // Entities and ground items: seen when a line of sight inside the field of view
    // reaches them, near within the eight-block surroundings ring, heard within
    // sixteen blocks otherwise (living entities only; items make no sound).
    private void SampleEntities(Entity player, Point3 eyePoint, Vec3d origin, double yaw, double pitch,
        double halfYaw, double halfPitch, int radius, long now)
    {
        int rays = 0;
        foreach (var entity in api.World.GetEntitiesAround(origin, Math.Max(radius, (float)HearingRange), Math.Max(radius, (float)HearingRange)))
        {
            if (entity.EntityId == player.EntityId || entity.Pos.Dimension != 0) continue;
            bool item = entity is EntityItem;
            if (!item && (!entity.Alive || entity.Code == null)) continue;
            var stack = (entity as EntityItem)?.Itemstack;
            string? code = item ? stack?.Collectible?.Code?.ToString() : entity.Code!.ToString();
            if (code == null) continue;
            var box = entity.SelectionBox ?? entity.CollisionBox;
            var point = new Point3(entity.Pos.X, entity.Pos.Y + (box == null ? 0.1 : (box.Y1 + box.Y2) / 2), entity.Pos.Z);
            double distance = SceneGeometry.Distance(eyePoint, point);
            string? how = null;
            if (distance <= 8) how = "near";
            else
            {
                var look = SceneGeometry.LookAt(eyePoint, point);
                bool inView = distance <= radius && Math.Abs(SceneGeometry.Normalize(look.Yaw - yaw + 180) - 180) <= halfYaw &&
                    Math.Abs(look.Pitch - pitch) <= halfPitch;
                if (inView && rays < 32)
                {
                    rays++;
                    BlockSelection? blockHit = null; EntitySelection? entityHit = null;
                    api.World.RayTraceForSelection(origin, new Vec3d(point.X, point.Y, point.Z), ref blockHit, ref entityHit,
                        (at, b) => Sight.Occludes(api.World.BlockAccessor, at, b), _ => false);
                    if (blockHit == null) how = "seen";
                }
                if (how == null && !item && distance <= HearingRange) how = "heard";
            }
            if (how == null) continue;
            sightings.Put($"entity:{entity.EntityId}", item ? "item" : "entity", code, point, how,
                item ? new { quantity = stack?.StackSize } : null, now);
        }
    }
}
