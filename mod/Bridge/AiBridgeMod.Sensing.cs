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

// Read-only perception: own state, life sampling, terrain deltas, sight scans, target keys.
public sealed partial class AiBridgeMod
{

    private object Observe()
    {
        var entity = api.World!.Player.Entity;
        var pos = entity.Pos;
        return new
        {
            ok = true,
            capabilities = new[] { "target_guard", "directional_move", "scan", "nearby_awareness", "nearby_entities", "distant_sight", "environment", "player_condition", "inspect_target", "equipment", "forage_state", "food_freshness", "life_events", "respawn", "inventory", "grid_craft", "background_control", "control_frames", "terrain_deltas", "background_jump", "background_sprint", "block_actions", "sneak", "forming", "chat", "aim_cell", "ui_dialogs", "surface_survey" },
            observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            player = new { name = api.World!.Player.PlayerName, uid = api.World.Player.PlayerUID },
            world = new { singleplayer = api.IsSinglePlayer, gameMode = api.World.Player.WorldData.CurrentGameMode.ToString() },
            position = new { x = pos.X, y = pos.Y, z = pos.Z, dimension = pos.Dimension },
            orientation = new
            {
                yaw = pos.Yaw, pitch = pos.Pitch,
                yawDegrees = NormalizeDegrees(pos.Yaw * 180 / Math.PI),
                pitchDegrees = (pos.Pitch - Math.PI) * 180 / Math.PI
            },
            alive = entity.Alive,
            life = LifeState(),
            vitals = new { health = Vital("health", "currenthealth", "maxhealth"), hunger = Vital("hunger", "currentsaturation", "maxsaturation"), oxygen = Vital("oxygen", "currentoxygen", "maxoxygen") },
            motion = new { onGround = entity.OnGround, swimming = entity.Swimming, feetInLiquid = entity.FeetInLiquid,
                collided = entity.CollidedHorizontally, collidedVertically = entity.CollidedVertically,
                engineMotion = new { x = pos.Motion.X, y = pos.Motion.Y, z = pos.Motion.Z },
                climbing = entity.Controls.IsClimbing, sneaking = entity.Controls.Sneak, sprinting = entity.Controls.Sprint },
            condition = context.Condition(),
            paused = api.IsGamePaused,
            mouseGrabbed = api.Input.MouseGrabbed,
            controlReady = CanControl(),
            control = control.Observe(Environment.TickCount64),
            body = new { halfWidth = Math.Max(Math.Max(Math.Abs(entity.CollisionBox.X1), Math.Abs(entity.CollisionBox.X2)),
                Math.Max(Math.Abs(entity.CollisionBox.Z1), Math.Abs(entity.CollisionBox.Z2))), height = entity.CollisionBox.Y2,
                eyeHeight = entity.LocalEyePos.Y },
            mounted = entity.MountedOn != null,
            nearbyEntities = sensor.NearbyEntities(),
            moving = movingControls != null,
            moveDirection = movingControls == null ? null : moveDirection,
            remainingMs = movingControls == null ? 0 : Math.Max(0, stopAt - Environment.TickCount64),
            handAction,
            handRemainingMs = handAction == null ? 0 : Math.Max(0, handStopAt - Environment.TickCount64),
            blockAction = blockActions.Observe(),
            target = ObserveTarget(),
            activeSlot = api.World.Player.InventoryManager.ActiveHotbarSlotNumber,
            hotbar = ObserveInventory("hotbar"),
            backpack = ObserveInventory("backpack")
        };
    }

    private object Sense(JsonElement request)
    {
        long cursor = 0;
        if (request.TryGetProperty("after", out var cursorField) && (!cursorField.TryGetInt64(out cursor) || cursor < 0))
            return new { ok = false, error = "Invalid terrain cursor." };
        string? terrainSession = request.TryGetProperty("session", out var terrainSessionField) && terrainSessionField.ValueKind == JsonValueKind.String
            ? terrainSessionField.GetString() : null;
        return new { ok = true, state = Observe(),
            terrain = terrain.Read(cursor, terrainSession, Environment.TickCount64) };
    }

    private object Scan(JsonElement request)
    {
        int radius = 8, limit = 16;
        if (request.TryGetProperty("radius", out _) && (!TryInteger(request, "radius", out radius) || radius < 1 || radius > 64) ||
            request.TryGetProperty("limit", out _) && (!TryInteger(request, "limit", out limit) || limit < 1 || limit > 32))
            return new { ok = false, error = "radius: integer 1–64; limit: integer 1–32." };
        string kind = "all";
        string[] matches = [];
        if (request.TryGetProperty("kind", out var kindField))
        {
            if (kindField.ValueKind != JsonValueKind.String) return new { ok = false, error = "kind must be a string." };
            kind = kindField.GetString()!;
        }
        if (request.TryGetProperty("match", out var matchField))
        {
            if (matchField.ValueKind != JsonValueKind.String || matchField.GetString()!.Length > 64)
                return new { ok = false, error = "match must be a string of at most 64 characters." };
            if (matchField.GetString()!.Length > 0) matches = [matchField.GetString()!];
        }
        if (request.TryGetProperty("matches", out var matchesField))
        {
            if (matches.Length != 0 || matchesField.ValueKind != JsonValueKind.Array || matchesField.GetArrayLength() is < 1 or > 4 ||
                matchesField.EnumerateArray().Any(value => value.ValueKind != JsonValueKind.String || value.GetString()!.Length is < 1 or > 64))
                return new { ok = false, error = "matches must be 1–4 strings of 1–64 characters and cannot accompany match." };
            matches = matchesField.EnumerateArray().Select(value => value.GetString()!).ToArray();
        }
        if (kind is not ("all" or "blocks" or "items" or "entities")) return new { ok = false, error = "Invalid scan kind." };
        string? scanCursor = null;
        if (request.TryGetProperty("cursor", out var scanCursorField))
        {
            if (scanCursorField.ValueKind != JsonValueKind.String || !Guid.TryParseExact(scanCursorField.GetString(), "N", out _))
                return new { ok = false, error = "cursor must be a returned scan cursor." };
            scanCursor = scanCursorField.GetString();
        }
        return sensor.Scan(radius, limit, kind, matches, scanCursor);
    }

    private object Survey(JsonElement request)
    {
        int radius = 48;
        if (request.TryGetProperty("radius", out _) && (!TryInteger(request, "radius", out radius) || radius < 8 || radius > 64))
            return new { ok = false, error = "radius: integer 8–64." };
        string? surveyCursor = null;
        if (request.TryGetProperty("cursor", out var surveyCursorField))
        {
            if (surveyCursorField.ValueKind != JsonValueKind.String || !Guid.TryParseExact(surveyCursorField.GetString(), "N", out _))
                return new { ok = false, error = "cursor must be a returned survey cursor." };
            surveyCursor = surveyCursorField.GetString();
        }
        return survey.Survey(radius, surveyCursor);
    }

    private object Events(JsonElement request)
    {
        long after = 0;
        if (request.TryGetProperty("after", out var afterField) &&
            (afterField.ValueKind != JsonValueKind.Number || !afterField.TryGetInt64(out after) || after < 0))
            return new { ok = false, error = "after must be a nonnegative integer." };
        string? session = null;
        if (request.TryGetProperty("session", out var sessionField))
        {
            if (sessionField.ValueKind != JsonValueKind.String || sessionField.GetString()!.Length > 64)
                return new { ok = false, error = "Invalid event session." };
            session = sessionField.GetString();
        }
        return life.Read(after, session);
    }

    private object Recipes(JsonElement request)
    {
        if (!request.TryGetProperty("match", out var recipeMatch) || recipeMatch.ValueKind != JsonValueKind.String ||
            recipeMatch.GetString()!.Length is < 1 or > 64)
            return new { ok = false, error = "Recipe match must be 1–64 characters of output code." };
        int offset = 0, recipeLimit = 4;
        if (request.TryGetProperty("offset", out _) && (!TryInteger(request, "offset", out offset) || offset < 0 || offset > 100000) ||
            request.TryGetProperty("limit", out _) && (!TryInteger(request, "limit", out recipeLimit) || recipeLimit < 1 || recipeLimit > 8))
            return new { ok = false, error = "offset: 0–100000; limit: 1–8." };
        return inventory.Recipes(recipeMatch.GetString()!, offset, recipeLimit);
    }

    private object Respawn(JsonElement request)
    {
        var entity = api.World!.Player.Entity;
        if (!request.TryGetProperty("deathId", out var deathField) || deathField.ValueKind != JsonValueKind.String ||
            deathField.GetString() != life.DeathId || entity.Alive)
            return new { ok = false, error = "Observe life.deathId and request respawn only for that death." };
        if (life.RespawnRequestedAt != null)
            return new { ok = true, status = "pending", deathId = life.DeathId };
        if (!CanRespawn() || api.World is not ClientMain game)
            return new { ok = false, error = "Respawn unavailable: wait for death dialog, check lives/paused state." };
        StopMovement();
        StopHandAction();
        if (!life.RequestRespawn(deathField.GetString()!, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()))
            return new { ok = false, error = "Respawn state changed; observe again." };
        // Same public client method used by GuiDialogDead.OnRespawn; server validates.
        game.Respawn();
        return new { ok = true, status = "requested", deathId = life.DeathId };
    }

    private object? Vital(string tree, string current, string maximum)
    {
        var values = api.World.Player.Entity.WatchedAttributes.GetTreeAttribute(tree);
        if (values == null) return null;
        return new { current = values.TryGetFloat(current), max = values.TryGetFloat(maximum) };
    }

    private void SampleLife()
    {
        var entity = api.World?.Player?.Entity;
        if (entity == null) return;
        var health = entity.WatchedAttributes.GetTreeAttribute("health");
        var hunger = entity.WatchedAttributes.GetTreeAttribute("hunger");
        var oxygen = entity.WatchedAttributes.GetTreeAttribute("oxygen");
        var previousDamage = life.LastDamageAt;
        if (life.Sample(entity.Alive, health?.TryGetFloat("currenthealth"), new(entity.Pos.X, entity.Pos.Y, entity.Pos.Z),
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), health?.TryGetFloat("maxhealth"),
            hunger?.TryGetFloat("currentsaturation"), hunger?.TryGetFloat("maxsaturation"),
            oxygen?.TryGetFloat("currentoxygen"), oxygen?.TryGetFloat("maxoxygen"), (float?)ContextSensor.Number(entity.WatchedAttributes, "temporalStability")))
        {
            if (!entity.Alive || life.LastDamageAt != previousDamage || NavigationDanger(control.StarvingRecovery)) ReleaseControl("danger");
            StopMovement();
            StopHandAction();
        }
    }

    // The caller may request this narrow scope only for an explicit food
    // recovery episode. Keep low health tolerated after eating clears the
    // low-food alert so that the same episode can finish building a reserve.
    private bool NavigationDanger(bool starvingRecovery = false) => life.Alerts.Any(alert => alert != "low_food" &&
        !(alert == "low_health" && starvingRecovery));

    private int? RemainingLives()
    {
        if (!int.TryParse(api.World.Config.GetString("playerlives", "-1"), out int limit) || limit < 0) return null;
        return Math.Max(0, limit - api.World.Player.WorldData.Deaths);
    }

    private bool CanRespawn() => api.World.Player.Entity.Alive == false && !api.IsGamePaused &&
        RemainingLives() != 0 && life.RespawnRequestedAt == null &&
        api.Gui.OpenedGuis.OfType<GuiDialogDead>().Any(dialog => dialog.IsOpened());

    private object LifeState() => new
    {
        state = api.World.Player.Entity.Alive ? "alive" : life.RespawnRequestedAt != null ? "respawn_pending" : "dead",
        session = life.Session, deathId = life.DeathId, canRespawn = CanRespawn(),
        alerts = life.Alerts, lastDamageAt = life.LastDamageAt, lastAttritionAt = life.LastAttritionAt,
        livesRemaining = RemainingLives(), respawnRequestedAt = life.RespawnRequestedAt,
        revivableMinutes = api.World.Player.Entity.Alive ? (double?)null : Math.Max(0, api.World.Player.Entity.RevivableIngameHoursLeft() * 60)
    };

    private object[] ObserveInventory(string name)
    {
        var inventory = api.World.Player.InventoryManager.GetOwnInventory(name);
        if (inventory == null) return [];
        return Enumerable.Range(0, inventory.Count).Select(index =>
        {
            var stack = inventory[index]?.Itemstack;
            return (object)new { slot = index, code = stack?.Collectible.Code.ToString(), quantity = stack?.StackSize ?? 0 };
        }).ToArray();
    }

    private object? ObserveTarget()
    {
        // Use the client's actual selection; don't expose hidden blocks or distant entities.
        if (!CanControl()) return null;
        var player = api.World.Player;
        var block = player.CurrentBlockSelection;
        if (block != null)
        {
            var pos = block.Position;
            return new
            {
                kind = "block", key = CurrentTargetKey(),
                code = api.World.BlockAccessor.GetBlock(pos).Code.ToString(),
                position = new { x = pos.X, y = pos.Y, z = pos.Z, dimension = pos.dimension },
                face = block.Face?.Code,
                selectionBox = block.SelectionBoxIndex
            };
        }
        var selectedEntity = player.CurrentEntitySelection?.Entity;
        return selectedEntity == null ? null : new { kind = "entity", key = CurrentTargetKey(), code = selectedEntity.Code.ToString(), id = selectedEntity.EntityId };
    }

    private string? CurrentTargetKey()
    {
        var block = api.World?.Player?.CurrentBlockSelection;
        if (block != null)
        {
            var pos = block.Position;
            return $"block:{pos.dimension}:{pos.X}:{pos.Y}:{pos.Z}:{api.World!.BlockAccessor.GetBlock(pos).Code}";
        }
        var entity = api.World?.Player?.CurrentEntitySelection?.Entity;
        return entity == null ? null : $"entity:{entity.EntityId}";
    }
}
