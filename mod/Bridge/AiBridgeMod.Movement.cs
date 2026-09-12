using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Vintagestory.API.Client;
using Vintagestory.API.Common;
using Vintagestory.API.Config;
using Vintagestory.API.MathTools;
using Vintagestory.Client.NoObf;

namespace VintageStoryAI;

// Movement and aiming under a control hold, through the normal keyboard/mouse state; manual input or danger releases it.
public sealed partial class AiBridgeMod
{
    private enum LockKind { None, Block, Entity, Point }
    private LockKind lockKind = LockKind.None;
    private BlockPos? lockCell;
    private string? lockCode;
    private long lockEntityId;
    private Point3 lockPoint;
    private string? lockName;

    private EntityControls? movingControls;
    private int[] movingKeys = [];
    private string moveDirection = "forward";
    private bool moveJump;
    private bool moveSprint;
    private bool moveSneak;
    private long stopAt;
    // The step a toward-frame is walking, tracked every tick; null for plain frames.
    private StepTracker? step;
    private readonly ControlHold control = new();
    private double controlYaw, controlPitch;
    private Cell? sensorPriority;

    private object ControlBegin(JsonElement request)
    {
        var entity = api.World!.Player.Entity;
        if (!request.TryGetProperty("owner", out var ownerField) || ownerField.ValueKind != JsonValueKind.String ||
            !Guid.TryParseExact(ownerField.GetString(), "N", out _) ||
            !request.TryGetProperty("session", out var controlSession) || controlSession.GetString() != life.Session ||
            !request.TryGetProperty("epoch", out var epochField) || !epochField.TryGetInt64(out long epoch))
            return new { ok = false, error = "Supply owner UUID, observed life session and control epoch." };
        bool controlRecovery = request.TryGetProperty("allowStarvingRecovery", out var controlRecoveryField) &&
            controlRecoveryField.ValueKind == JsonValueKind.True;
        if (request.TryGetProperty("allowStarvingRecovery", out controlRecoveryField) &&
            controlRecoveryField.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            return new { ok = false, error = "allowStarvingRecovery must be boolean." };
        if (!CanControl() || ManualInput() || entity.MountedOn != null)
            return new { ok = false, error = "Controls unavailable." };
        if (!control.Begin(ownerField.GetString()!, epoch, Environment.TickCount64, controlRecovery))
            return new { ok = false, error = "Control epoch changed or another controller owns inputs." };
        // A walk owns the camera: no look set before it is kept.
        StopActs(); ClearTargetLock();
        controlYaw = entity.Pos.Yaw * 180 / Math.PI; controlPitch = (entity.Pos.Pitch - Math.PI) * 180 / Math.PI;
        return new { ok = true, control = control.Observe(Environment.TickCount64) };
    }

    private object ControlEnd(JsonElement request)
    {
        if (!request.TryGetProperty("owner", out var endOwner) || endOwner.GetString() != control.Owner || !control.Active)
            return new { ok = false, error = "Not the input owner." };
        ReleaseControl("released");
        return new { ok = true, status = "stopped" };
    }

    private object ControlFrame(string action, JsonElement request, long? receivedAt)
    {
        var entity = api.World!.Player.Entity;
        bool includeSense = action == "control_step";
        long stepCursor = 0, stepSeen = 0;
        string? stepSession = null;
        if (includeSense)
        {
            if (request.TryGetProperty("after", out var stepCursorField) && (!stepCursorField.TryGetInt64(out stepCursor) || stepCursor < 0))
                return new { ok = false, error = "Invalid terrain cursor." };
            stepSession = request.TryGetProperty("session", out var stepSessionField) && stepSessionField.ValueKind == JsonValueKind.String
                ? stepSessionField.GetString() : null;
            if (ReadSeen(request, out stepSeen) is { } seenError) return new { ok = false, error = seenError };
        }
        if (!request.TryGetProperty("owner", out var frameOwner) || frameOwner.ValueKind != JsonValueKind.String ||
            !request.TryGetProperty("sequence", out var sequenceField) || !sequenceField.TryGetInt64(out long sequence) ||
            !TryInteger(request, "durationMs", out int frameDuration) || frameDuration is < 1 or > 500 ||
            !TryNumber(request, "yawDegrees", out double frameYaw) || Math.Abs(frameYaw) > 36000 ||
            !TryNumber(request, "pitchDegrees", out double framePitch) || Math.Abs(framePitch) > 89 ||
            !request.TryGetProperty("forward", out var forwardField) || forwardField.ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
            !request.TryGetProperty("jump", out var frameJump) || frameJump.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            return new { ok = false, error = "Invalid control frame." };
        Cell? focus = null;
        bool sprinting = false, frameSneak = false;
        if (request.TryGetProperty("sprint", out var frameSprint))
        {
            if (frameSprint.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                return new { ok = false, error = "sprint must be boolean." };
            sprinting = frameSprint.GetBoolean();
        }
        if (request.TryGetProperty("sneak", out var frameSneakField))
        {
            if (frameSneakField.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                return new { ok = false, error = "sneak must be boolean." };
            frameSneak = frameSneakField.GetBoolean();
        }
        // A step: walk toward a point until on it, blocked or expired, the hand on the keys every tick.
        Point3? toward = null, then = null; double reach = 0.35, reachY = 0.6; bool hop = false, thenHop = false;
        if (request.TryGetProperty("toward", out var towardField) && towardField.ValueKind != JsonValueKind.Null)
        {
            if (!TryNumber(towardField, "x", out double tx) || !TryNumber(towardField, "y", out double ty) || !TryNumber(towardField, "z", out double tz) ||
                SceneGeometry.Distance(new(entity.Pos.X, entity.Pos.Y, entity.Pos.Z), new(tx, ty, tz)) > 8)
                return new { ok = false, error = "toward must be a point within 8 blocks." };
            toward = new Point3(tx, ty, tz);
            if (request.TryGetProperty("reach", out var reachField) && (!reachField.TryGetDouble(out reach) || reach is < 0.15 or > 1.5))
                return new { ok = false, error = "reach must be 0.15 to 1.5 blocks." };
            if (request.TryGetProperty("reachY", out var reachYField) && (!reachYField.TryGetDouble(out reachY) || reachY is < 0.2 or > 3))
                return new { ok = false, error = "reachY must be 0.2 to 3 blocks." };
            if (request.TryGetProperty("hop", out var hopField))
            {
                if (hopField.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return new { ok = false, error = "hop must be boolean." };
                hop = hopField.GetBoolean();
            }
            // The point after this one (next), to roll on to without a pause: within 8 blocks like the first.
            if (request.TryGetProperty("next", out var thenField) && thenField.ValueKind == JsonValueKind.Object)
            {
                if (!TryNumber(thenField, "x", out double nx) || !TryNumber(thenField, "y", out double ny) || !TryNumber(thenField, "z", out double nz) ||
                    SceneGeometry.Distance(new(entity.Pos.X, entity.Pos.Y, entity.Pos.Z), new(nx, ny, nz)) > 8)
                    return new { ok = false, error = "next must be a point within 8 blocks." };
                then = new Point3(nx, ny, nz);
                thenHop = thenField.TryGetProperty("hop", out var thenHopField) && thenHopField.ValueKind == JsonValueKind.True;
            }
        }
        if (request.TryGetProperty("focus", out var focusField) && focusField.ValueKind != JsonValueKind.Null)
        {
            if (!TryInteger(focusField, "x", out int fx) || !TryInteger(focusField, "y", out int fy) || !TryInteger(focusField, "z", out int fz) ||
                SceneGeometry.Distance(new(entity.Pos.X, entity.Pos.Y, entity.Pos.Z), new(fx, fy, fz)) > 8)
                return new { ok = false, error = "Focus must be a nearby cell; it never bypasses visibility." };
            focus = new(fx, fy, fz);
        }
        if (!CanControl() || ManualInput() || entity.MountedOn != null)
        { ReleaseControl("control_unavailable"); return new { ok = false, error = "Controls unavailable." }; }
        long frameNow = Environment.TickCount64;
        if (!control.Frame(frameOwner.GetString()!, sequence, receivedAt ?? frameNow, frameNow, frameDuration))
            return new { ok = false, error = control.RefusalReason(frameOwner.GetString()!, sequence, receivedAt ?? frameNow, frameDuration) };
        // The step in flight is kept: the next frame may roll on from it.
        StopMovement(keepStep: true); StopHandAction();
        sensorPriority = focus; controlYaw = frameYaw; controlPitch = framePitch;
        bool frameForward = forwardField.GetBoolean(), jumping = frameJump.GetBoolean();
        if (toward is Point3 point)
        {
            var at = new Point3(entity.Pos.X, entity.Pos.Y, entity.Pos.Z);
            if (step == null || !step.Continues(point, then) || step.State != "walking") step = new StepTracker(point, at, reach, reachY, hop, frameNow);
            step.Queue(then, thenHop);
            // The tracker presses forward and jump itself; the keys are only registered here.
            frameForward = true; jumping = false;
        }
        else step = null;
        string[] frameMappings = frameForward ? (jumping || toward != null ? ["walkforward", "jump"] : ["walkforward"]) : jumping ? ["jump"] : [];
        if (sprinting && frameForward && !frameSneak) frameMappings = [..frameMappings, "sprint"];
        if (frameSneak) frameMappings = [..frameMappings, "sneak"];
        var frameKeys = frameMappings.Select(name => api.Input.GetHotKeyByCode(name)?.CurrentMapping.KeyCode ?? -1).ToArray();
        if (frameKeys.Any(key => key < 0 || key >= api.Input.KeyboardKeyState.Length))
        { ReleaseControl("binding_unavailable"); return new { ok = false, error = "Movement binding unavailable." }; }
        if (frameKeys.Length > 0)
        {
            movingKeys = frameKeys; movingControls = entity.Controls; moveDirection = frameForward ? "forward" : "none";
            moveJump = jumping; moveSprint = sprinting && frameForward && !frameSneak; moveSneak = frameSneak;
            // Input duration remains exactly caller-bounded even though
            // the ownership heartbeat has a fixed 500 ms grace period.
            stopAt = frameNow + frameDuration; SetMovement(true);
        }
        if (includeSense)
        {
            lastSenseAt = Environment.TickCount64;
            if (step != null) ApplyStep(lastSenseAt);
            return new { ok = true, sequence, step = step?.View(), state = Observe(),
                terrain = terrain.Read(stepCursor, stepSession, lastSenseAt),
                surface = vision.Surface(lastSenseAt), sightings = vision.Sightings(lastSenseAt, stepSeen) };
        }
        if (step != null) ApplyStep(frameNow);
        return new { ok = true, sequence, step = step?.View() };
    }

    private object Move(JsonElement request)
    {
        var entity = api.World!.Player.Entity;
        if (!request.TryGetProperty("durationMs", out var duration) || duration.ValueKind != JsonValueKind.Number ||
            !duration.TryGetInt32(out int milliseconds) || milliseconds < 1 || milliseconds > 2000)
            return new { ok = false, error = "durationMs must be an integer from 1 to 2000." };
        if (!CanControl())
            return new { ok = false, error = "Cannot move while dead, paused, or in menus." };
        string direction = "forward";
        bool jump = false;
        bool sprintMove = false;
        if (request.TryGetProperty("direction", out var directionField))
        {
            if (directionField.ValueKind != JsonValueKind.String) return new { ok = false, error = "direction must be a string." };
            direction = directionField.GetString()!;
        }
        if (direction is not ("forward" or "backward" or "left" or "right")) return new { ok = false, error = "Invalid movement direction." };
        if (request.TryGetProperty("jump", out var jumpField))
        {
            if (jumpField.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return new { ok = false, error = "jump must be boolean." };
            jump = jumpField.GetBoolean();
        }
        StopActs();
        if (request.TryGetProperty("sprint", out var sprintField))
        {
            if (sprintField.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                return new { ok = false, error = "sprint must be boolean." };
            sprintMove = sprintField.GetBoolean();
        }
        bool sneakMove = false;
        if (request.TryGetProperty("sneak", out var sneakField))
        {
            if (sneakField.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                return new { ok = false, error = "sneak must be boolean." };
            sneakMove = sneakField.GetBoolean();
        }
        if (sneakMove) sprintMove = false;
        string[] mappings = jump ? ["walk" + direction, "jump"] : ["walk" + direction];
        if (sprintMove) mappings = [..mappings, "sprint"];
        if (sneakMove) mappings = [..mappings, "sneak"];
        var keys = mappings.Select(name => api.Input.GetHotKeyByCode(name)?.CurrentMapping.KeyCode ?? -1).ToArray();
        if (keys.Any(key => key < 0 || key >= api.Input.KeyboardKeyState.Length || api.Input.KeyboardKeyState[key]))
            return new { ok = false, error = "Movement binding unavailable or manually pressed." };
        movingKeys = keys;
        moveDirection = direction;
        moveJump = jump;
        moveSprint = sprintMove;
        moveSneak = sneakMove;
        movingControls = entity.Controls;
        stopAt = Environment.TickCount64 + milliseconds;
        SetMovement(true);
        return new { ok = true, status = "started", durationMs = milliseconds };
    }

    private object Look(JsonElement request)
    {
        var entity = api.World!.Player.Entity;
        if (!TryNumber(request, "yawDegrees", out double yaw) ||
            !TryNumber(request, "pitchDegrees", out double pitch) || pitch < -89 || pitch > 89 || Math.Abs(yaw) > 36000)
            return new { ok = false, error = "Supply finite yawDegrees (-36000 to 36000) and pitchDegrees (-89 up to 89 down)." };
        if (!entity.Alive || api.IsGamePaused)
            return new { ok = false, error = "Cannot look while dead or paused." };
        StopHandAction();
        ClearTargetLock();
        api.Input.MouseYaw = entity.Pos.Yaw = (float)(NormalizeDegrees(yaw) * Math.PI / 180);
        api.Input.MousePitch = entity.Pos.Pitch = (float)(Math.PI + pitch * Math.PI / 180);
        return new { ok = true, status = "looking", yawDegrees = NormalizeDegrees(yaw), pitchDegrees = pitch };
    }

    private object AimCell(JsonElement request)
    {
        var entity = api.World!.Player.Entity;
            if (!TryInteger(request, "x", out int ax) || !TryInteger(request, "y", out int ay) || !TryInteger(request, "z", out int az))
                return new { ok = false, error = "Supply integer cell x, y, z." };
            if (!CanControl()) return new { ok = false, error = "Close menus and enter the world before aiming." };
            if (!entity.Alive || api.IsGamePaused) return new { ok = false, error = "Cannot aim while dead or paused." };
            // Aiming is a look of its own: a target lock would swing the crosshair back next tick.
            ClearTargetLock();
            var cellPos = new BlockPos(ax, ay, az, 0);
            if (api.World.BlockAccessor.GetChunkAtBlockPos(cellPos) == null)
                return new { ok = false, error = "Target cell unloaded." };
            var eyeVec = entity.Pos.XYZ.Add(entity.LocalEyePos);
            var aimEye = new Point3(eyeVec.X, eyeVec.Y, eyeVec.Z);
            if (SceneGeometry.Distance(aimEye, new Point3(ax + 0.5, ay + 0.5, az + 0.5)) > 8)
                return new { ok = false, error = "Target cell out of reach." };
            string? aimFace = request.TryGetProperty("face", out var faceField) && faceField.ValueKind == JsonValueKind.String ? faceField.GetString() : null;
            Point3 aimTarget;
            if (request.TryGetProperty("voxel", out var voxelField) && voxelField.ValueKind == JsonValueKind.Array)
            {
                var v = voxelField.EnumerateArray().Select(e => e.TryGetInt32(out int n) ? n : -1).ToArray();
                if (v.Length != 3 || v.Any(n => n < 0 || n > 15)) return new { ok = false, error = "voxel must be three integers 0-15." };
                // Voxel top-centre, for aiming at knapping/clay surface voxels.
                aimTarget = new Point3(ax + (v[0] + 0.5) / 16.0, ay + (v[1] + 0.95) / 16.0, az + (v[2] + 0.5) / 16.0);
            }
            else aimTarget = BlockAimPoint(api.World.BlockAccessor, api.World.BlockAccessor.GetBlock(cellPos), cellPos, aimFace);
            var (aimYaw, aimPitch) = SceneGeometry.LookAt(aimEye, aimTarget);
            aimPitch = Math.Clamp(aimPitch, -89, 89);
            StopHandAction();
            api.Input.MouseYaw = entity.Pos.Yaw = (float)(SceneGeometry.Normalize(aimYaw) * Math.PI / 180);
            api.Input.MousePitch = entity.Pos.Pitch = (float)(Math.PI + aimPitch * Math.PI / 180);
            return new { ok = true, status = "aiming", yawDegrees = SceneGeometry.Normalize(aimYaw), pitchDegrees = aimPitch,
                target = new { x = aimTarget.X, y = aimTarget.Y, z = aimTarget.Z } };
    }

    // A target lock is one continuous look: Node names the target, the mod
    // eases the camera onto it every tick and follows it if it moves. It owns
    // the camera while engaged, so movement frames should echo observed yaw.
    private object LookAt(JsonElement request)
    {
        var entity = api.World!.Player.Entity;
        if (!entity.Alive || api.IsGamePaused)
            return new { ok = false, error = "Cannot aim while dead or paused." };
        if (!CanControl())
            return new { ok = false, error = "Close menus and enter the world before aiming." };
        string? key = null;
        if (request.TryGetProperty("entity", out var entityField) && entityField.ValueKind == JsonValueKind.String)
            key = entityField.GetString()!;
        else if (request.TryGetProperty("target", out var targetField) && targetField.ValueKind == JsonValueKind.String)
            key = targetField.GetString()!;
        LockKind kind = LockKind.None;
        BlockPos? cell = null;
        string? code = null;
        long entityId = 0;
        Point3 point = default;
        if (key != null)
        {
            var parts = key.Split(':');
            if (parts.Length >= 6 && parts[0] == "block" && int.TryParse(parts[1], out int dim) &&
                int.TryParse(parts[2], out int x) && int.TryParse(parts[3], out int y) && int.TryParse(parts[4], out int z))
            {
                cell = new BlockPos(x, y, z, dim);
                if (api.World.BlockAccessor.GetChunkAtBlockPos(cell) == null)
                    return new { ok = false, error = "Target cell unloaded." };
                code = string.Join(":", parts[5..]);
                kind = LockKind.Block;
            }
            else if (parts.Length == 2 && parts[0] == "entity" && long.TryParse(parts[1], out entityId) &&
                api.World.GetEntityById(entityId) != null)
            {
                kind = LockKind.Entity;
            }
            else return new { ok = false, error = "Unknown target; use an observed block key or sighted entity id." };
        }
        else if (request.TryGetProperty("x", out _) || request.TryGetProperty("y", out _) || request.TryGetProperty("z", out _))
        {
            if (!TryNumber(request, "x", out double px) || !TryNumber(request, "y", out double py) || !TryNumber(request, "z", out double pz))
                return new { ok = false, error = "Supply finite x, y, z." };
            point = new Point3(px, py, pz);
            key = $"point:{px}:{py}:{pz}";
            kind = LockKind.Point;
        }
        else return new { ok = false, error = "Supply target, entity, or x/y/z." };
        StopHandAction();
        lockKind = kind; lockCell = cell; lockCode = code; lockEntityId = entityId; lockPoint = point; lockName = key;
        UpdateTargetLock();
        return new { ok = true, status = "tracking", target = lockName };
    }

    private static Point3 BlockAimPoint(IBlockAccessor accessor, Block block, BlockPos pos, string? face)
    {
        // Aim at the centre of the requested face of the block's actual selection box, so the ray lands on it.
        var boxes = block.GetSelectionBoxes(accessor, pos);
        var box = boxes is { Length: > 0 } ? boxes[0] : new Cuboidf(0, 0, 0, 1, 1, 1);
        double mx = (box.X1 + box.X2) / 2, my = (box.Y1 + box.Y2) / 2, mz = (box.Z1 + box.Z2) / 2;
        return face switch
        {
            "up" => new Point3(pos.X + mx, pos.Y + box.Y2 - 0.02, pos.Z + mz),
            "down" => new Point3(pos.X + mx, pos.Y + box.Y1 + 0.02, pos.Z + mz),
            "north" => new Point3(pos.X + mx, pos.Y + my, pos.Z + box.Z1 + 0.02),
            "south" => new Point3(pos.X + mx, pos.Y + my, pos.Z + box.Z2 - 0.02),
            "west" => new Point3(pos.X + box.X1 + 0.02, pos.Y + my, pos.Z + mz),
            "east" => new Point3(pos.X + box.X2 - 0.02, pos.Y + my, pos.Z + mz),
            _ => new Point3(pos.X + mx, pos.Y + my, pos.Z + mz),
        };
    }

    private void UpdateTargetLock()
    {
        if (lockKind == LockKind.None) return;
        var entity = api.World!.Player.Entity;
        Point3? aim = null;
        if (lockKind == LockKind.Point) aim = lockPoint;
        else if (lockKind == LockKind.Entity)
        {
            var target = api.World.GetEntityById(lockEntityId);
            if (target == null) { ClearTargetLock(); return; }
            var box = target.SelectionBox;
            var p = target.Pos.XYZ;
            aim = box == null ? new Point3(p.X, p.Y + 0.5, p.Z)
                : new Point3(p.X + (box.X1 + box.X2) / 2, p.Y + (box.Y1 + box.Y2) / 2, p.Z + (box.Z1 + box.Z2) / 2);
        }
        else if (lockCell != null)
        {
            if (api.World.BlockAccessor.GetChunkAtBlockPos(lockCell) == null ||
                api.World.BlockAccessor.GetBlock(lockCell).Code.ToString() != lockCode) { ClearTargetLock(); return; }
            aim = BlockAimPoint(api.World.BlockAccessor, api.World.BlockAccessor.GetBlock(lockCell), lockCell, null);
        }
        if (!aim.HasValue) { ClearTargetLock(); return; }
        var eyeVec = entity.Pos.XYZ.Add(entity.LocalEyePos);
        var (yaw, pitch) = SceneGeometry.LookAt(new Point3(eyeVec.X, eyeVec.Y, eyeVec.Z), aim.Value);
        controlYaw = SceneGeometry.Normalize(yaw);
        controlPitch = Math.Clamp(pitch, -89, 89);
    }

    private void ClearTargetLock()
    {
        lockKind = LockKind.None; lockCell = null; lockCode = null; lockEntityId = 0; lockName = null;
    }

    private void RetainOwnedMovement(EnumEntityAction action, bool on, ref EnumHandling handling)
    {
        // Retain only inputs held under control against unfocused reset; normal control packets remain active.
        long now = Environment.TickCount64;
        bool moving = movingControls != null && now < stopAt;
        bool sneakOwned = action is EnumEntityAction.Sneak or EnumEntityAction.ShiftKey &&
            (moveSneak && moving || handSneak && handAction != null && now < handStopAt);
        var entity = api.World.Player.Entity;
        bool owned = sneakOwned || moving && (action == EnumEntityAction.Jump && moveJump &&
            (entity.PrevFrameCanStandUp || entity.FeetInLiquid || entity.Swimming) ||
            action == EnumEntityAction.Sprint && moveSprint);
        if (owned && !on && CanControl() && handling == EnumHandling.PassThrough) handling = EnumHandling.PreventDefault;
    }

    private bool ManualInput()
    {
        foreach (string name in new[] { "walkforward", "walkbackward", "walkleft", "walkright", "jump", "sprint", "sneak" })
        {
            int key = api.Input.GetHotKeyByCode(name)?.CurrentMapping.KeyCode ?? -1;
            if (key >= 0 && key < api.Input.KeyboardKeyStateRaw.Length && api.Input.KeyboardKeyStateRaw[key]) return true;
        }
        return false;
    }

    // The one way inputs are let go of: the hold, the keys and the step, the hand, and the look.
    // Every release path (stop, control_end, expiry, manual input, menus, death, world exit, a
    // failed act) comes through here, so nothing stays held by a path that forgot one of them.
    private void ReleaseControl(string reason)
    {
        control.Release(reason); sensorPriority = null;
        StopActs();
        ClearTargetLock();
    }
    // The act in progress ends before another begins: a new input is never layered on the last.
    private void StopActs()
    {
        StopMovement();
        StopHandAction();
    }

    private void ApplyCamera(float dt)
    {
        var entity = api.World.Player.Entity;
        // A mouse turn is as fast as the hand: up to 360 degrees a second, eased in near the target, and
        // not slower on a slow renderer (a long frame turns further, never less).
        double elapsed = Math.Clamp(dt, 0, .25);
        double turn = 360 * elapsed, blend = 1 - Math.Exp(-16 * elapsed);
        double yaw = entity.Pos.Yaw * 180 / Math.PI, pitch = (entity.Pos.Pitch - Math.PI) * 180 / Math.PI;
        double delta = SceneGeometry.Normalize(controlYaw - yaw + 180) - 180;
        api.Input.MouseYaw = entity.Pos.Yaw = (float)((yaw + Math.Clamp(delta * blend, -turn, turn)) * Math.PI / 180);
        api.Input.MousePitch = entity.Pos.Pitch = (float)(Math.PI + (pitch + Math.Clamp((controlPitch - pitch) * blend, -turn, turn)) * Math.PI / 180);
    }

    // Every stop ends the step in flight too (a stopped walk is not "walking"), so a later frame
    // toward the same point starts a fresh tracker instead of judging itself blocked or arrived
    // by a clock and a start point that stopped with the keys.
    private void StopMovement(bool keepStep = false)
    {
        if (!keepStep) step?.Expire();
        bool jumping = moveJump;
        bool sprinting = moveSprint;
        bool sneaking = moveSneak;
        moveJump = false;
        moveSprint = false;
        moveSneak = false;
        SetMovement(false);
        if (jumping && movingControls != null) movingControls.Jump = false;
        if (sprinting && movingControls != null) movingControls.Sprint = false;
        if (sneaking && movingControls != null && !(handSneak && handAction != null)) SetSneak(movingControls, false);
        movingControls = null;
        movingKeys = [];
        moveJump = false;
    }

    // One tick of a step: face the point, press forward while facing it and supported, jump in water or
    // for a hop; the frame's hold ends on its own when the step is over.
    private void ApplyStep(long now)
    {
        if (step == null || movingControls == null) return;
        var entity = api.World!.Player.Entity;
        var at = new Point3(entity.Pos.X, entity.Pos.Y, entity.Pos.Z);
        var (forward, jump, yaw) = step.Update(at, SceneGeometry.Normalize(entity.Pos.Yaw * 180 / Math.PI), entity.OnGround,
            entity.FeetInLiquid || entity.Swimming, now);
        controlYaw = yaw;
        if (step.State != "walking") { StopMovement(); return; }
        Press("walkforward", forward); movingControls.Forward = forward;
        Press("jump", jump); movingControls.Jump = jump;
        if (moveSprint) { Press("sprint", forward); movingControls.Sprint = forward; }
    }

    private void Press(string name, bool on)
    {
        int key = api.Input.GetHotKeyByCode(name)?.CurrentMapping.KeyCode ?? -1;
        if (key >= 0 && key < api.Input.KeyboardKeyState.Length) api.Input.KeyboardKeyState[key] = on || api.Input.KeyboardKeyStateRaw[key];
    }

    private void SetMovement(bool pressed)
    {
        foreach (int key in movingKeys) api.Input.KeyboardKeyState[key] = pressed || api.Input.KeyboardKeyStateRaw[key];
        if (movingControls == null) return;
        switch (moveDirection)
        {
            case "forward": movingControls.Forward = pressed; break;
            case "backward": movingControls.Backward = pressed; break;
            case "left": movingControls.Left = pressed; break;
            case "right": movingControls.Right = pressed; break;
        }
        if (moveJump) movingControls.Jump = pressed;
        if (moveSprint) movingControls.Sprint = pressed;
        if (moveSneak) SetSneak(movingControls, pressed);
    }
}
