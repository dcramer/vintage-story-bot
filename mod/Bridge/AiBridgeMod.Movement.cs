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

// Leased movement and aiming through the normal keyboard/mouse state; manual input or danger revokes.
public sealed partial class AiBridgeMod
{
    private EntityControls? movingControls;
    private int[] movingKeys = [];
    private string moveDirection = "forward";
    private bool moveJump;
    private bool moveSprint;
    private bool moveSneak;
    private long stopAt;
    private readonly ControlLease control = new();
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
        if (!CanControl() || ManualInput() || NavigationDanger(controlRecovery) || entity.MountedOn != null)
            return new { ok = false, error = "Controls unavailable." };
        if (!control.Begin(ownerField.GetString()!, epoch, Environment.TickCount64, controlRecovery))
            return new { ok = false, error = "Control epoch changed or another controller owns inputs." };
        StopMovement(); StopHandAction();
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
        long stepCursor = 0;
        string? stepSession = null;
        if (includeSense)
        {
            if (request.TryGetProperty("after", out var stepCursorField) && (!stepCursorField.TryGetInt64(out stepCursor) || stepCursor < 0))
                return new { ok = false, error = "Invalid terrain cursor." };
            stepSession = request.TryGetProperty("session", out var stepSessionField) && stepSessionField.ValueKind == JsonValueKind.String
                ? stepSessionField.GetString() : null;
            if (!TryWatch(request, out var watchError)) return new { ok = false, error = watchError };
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
        if (request.TryGetProperty("focus", out var focusField) && focusField.ValueKind != JsonValueKind.Null)
        {
            if (!TryInteger(focusField, "x", out int fx) || !TryInteger(focusField, "y", out int fy) || !TryInteger(focusField, "z", out int fz) ||
                SceneGeometry.Distance(new(entity.Pos.X, entity.Pos.Y, entity.Pos.Z), new(fx, fy, fz)) > 8)
                return new { ok = false, error = "Focus must be a nearby cell; it never bypasses visibility." };
            focus = new(fx, fy, fz);
        }
        if (!CanControl() || ManualInput() || NavigationDanger(control.StarvingRecovery) || entity.MountedOn != null)
        { ReleaseControl("control_unavailable"); return new { ok = false, error = "Controls unavailable." }; }
        long frameNow = Environment.TickCount64;
        if (!control.Frame(frameOwner.GetString()!, sequence, receivedAt ?? frameNow, frameNow, frameDuration))
            return new { ok = false, error = "Expired, revoked, duplicate or foreign control frame." };
        StopMovement(); StopHandAction();
        sensorPriority = focus; controlYaw = frameYaw; controlPitch = framePitch;
        bool frameForward = forwardField.GetBoolean(), jumping = frameJump.GetBoolean();
        string[] frameMappings = frameForward ? (jumping ? ["walkforward", "jump"] : ["walkforward"]) : jumping ? ["jump"] : [];
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
            return new { ok = true, sequence, state = Observe(),
                terrain = terrain.Read(stepCursor, stepSession, lastSenseAt),
                surface = vision.Surface(lastSenseAt), sightings = vision.Sightings(lastSenseAt) };
        }
        return new { ok = true, sequence };
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
        StopHandAction();
        StopMovement();
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
            else
            {
                // Aim at the centre of the requested face of the block's actual selection box, so the ray lands on it.
                var aimBlock = api.World.BlockAccessor.GetBlock(cellPos);
                var aimBoxes = aimBlock.GetSelectionBoxes(api.World.BlockAccessor, cellPos);
                var box = aimBoxes is { Length: > 0 } ? aimBoxes[0] : new Cuboidf(0, 0, 0, 1, 1, 1);
                double mx = (box.X1 + box.X2) / 2, my = (box.Y1 + box.Y2) / 2, mz = (box.Z1 + box.Z2) / 2;
                aimTarget = aimFace switch
                {
                    "up" => new Point3(ax + mx, ay + box.Y2 - 0.02, az + mz),
                    "down" => new Point3(ax + mx, ay + box.Y1 + 0.02, az + mz),
                    "north" => new Point3(ax + mx, ay + my, az + box.Z1 + 0.02),
                    "south" => new Point3(ax + mx, ay + my, az + box.Z2 - 0.02),
                    "west" => new Point3(ax + box.X1 + 0.02, ay + my, az + mz),
                    "east" => new Point3(ax + box.X2 - 0.02, ay + my, az + mz),
                    _ => new Point3(ax + mx, ay + my, az + mz),
                };
            }
            var (aimYaw, aimPitch) = SceneGeometry.LookAt(aimEye, aimTarget);
            aimPitch = Math.Clamp(aimPitch, -89, 89);
            StopHandAction();
            api.Input.MouseYaw = entity.Pos.Yaw = (float)(SceneGeometry.Normalize(aimYaw) * Math.PI / 180);
            api.Input.MousePitch = entity.Pos.Pitch = (float)(Math.PI + aimPitch * Math.PI / 180);
            return new { ok = true, status = "aiming", yawDegrees = SceneGeometry.Normalize(aimYaw), pitchDegrees = aimPitch,
                target = new { x = aimTarget.X, y = aimTarget.Y, z = aimTarget.Z } };
    }

    private void RetainOwnedMovement(EnumEntityAction action, bool on, ref EnumHandling handling)
    {
        // Retain only leased inputs against unfocused reset; normal control packets remain active.
        long now = Environment.TickCount64;
        bool moving = movingControls != null && now < stopAt;
        bool sneakOwned = action is EnumEntityAction.Sneak or EnumEntityAction.ShiftKey &&
            (moveSneak && moving || handSneak && handAction != null && now < handStopAt);
        bool owned = sneakOwned || moving && (action == EnumEntityAction.Jump && moveJump && api.World.Player.Entity.PrevFrameCanStandUp ||
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

    private void ReleaseControl(string reason)
    {
        control.Revoke(reason); sensorPriority = null; StopMovement();
    }

    private void ApplyCamera(float dt)
    {
        var entity = api.World.Player.Entity;
        double elapsed = Math.Clamp(dt, 0, .05);
        double turn = 180 * elapsed, blend = 1 - Math.Exp(-12 * elapsed);
        double yaw = entity.Pos.Yaw * 180 / Math.PI, pitch = (entity.Pos.Pitch - Math.PI) * 180 / Math.PI;
        double delta = SceneGeometry.Normalize(controlYaw - yaw + 180) - 180;
        api.Input.MouseYaw = entity.Pos.Yaw = (float)((yaw + Math.Clamp(delta * blend, -turn, turn)) * Math.PI / 180);
        api.Input.MousePitch = entity.Pos.Pitch = (float)(Math.PI + (pitch + Math.Clamp((controlPitch - pitch) * blend, -turn, turn)) * Math.PI / 180);
    }

    private void StopMovement()
    {
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
