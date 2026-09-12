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
using Vintagestory.GameContent;

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
            capabilities = new[] { "target_guard", "directional_move", "scan", "nearby_awareness", "nearby_entities", "distant_sight", "environment", "player_condition", "inspect_target", "equipment", "block_facts", "item_info", "food_freshness", "life_events", "respawn", "inventory", "grid_craft", "background_control", "control_frames", "terrain_deltas", "background_jump", "background_sprint", "block_actions", "sneak", "forming", "chat", "aim_cell", "ui_dialogs", "surface_vision", "sightings", "map_waypoints", "map_waypoint_add", "map_view", "map_hud_state", "drop", "containers", "look_at", "players", "catalog", "chat_messages", "can_see", "ui_close" },
            observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            player = new { name = api.World!.Player.PlayerName, uid = api.World.Player.PlayerUID },
            world = new { singleplayer = api.IsSinglePlayer, gameMode = api.World.Player.WorldData.CurrentGameMode.ToString(),
                identifier = api.World.SavegameIdentifier },
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
            pickingRange = api.World.Player.WorldData.PickingRange,
            // Only what is seen or heard this instant; Node remembers what left the view.
            nearbyEntities = NearbyEntities(),
            moving = movingControls != null,
            moveDirection = movingControls == null ? null : moveDirection,
            step = step?.View(),
            remainingMs = movingControls == null ? 0 : Math.Max(0, stopAt - Environment.TickCount64),
            handAction,
            handRemainingMs = handAction == null ? 0 : Math.Max(0, handStopAt - Environment.TickCount64),
            targetLock = lockKind == LockKind.None ? null : lockName,
            blockAction = blockActions.Observe(),
            target = ObserveTarget(),
            activeSlot = api.World.Player.InventoryManager.ActiveHotbarSlotNumber,
            hotbar = ObserveInventory("hotbar"),
            backpack = ObserveInventory("backpack")
        };
    }

    // Pixel/world calibration for the game-rendered World Map. The operator capture opens the native map,
    // takes the same window screenshot a human sees, then uses these three points for dashboard overlays.
    private object MapView()
    {
        var manager = api.ModLoader.GetModSystem<WorldMapManager>();
        var tracking = api.ModLoader.GetModSystem<SystemRemotePlayerTracking>();
        var players = tracking?.GetAllTrackedPlayerPositions().Select(packet =>
        {
            var player = packet.AssociatedPlayer ?? api.World.PlayerByUid(packet.PlayerUid);
            return new
            {
                name = player?.PlayerName ?? "Unknown player",
                x = packet.PosX,
                z = packet.PosZ,
                yawDegrees = NormalizeDegrees(packet.Yaw * 180 / Math.PI),
                self = packet.PlayerUid == api.World.Player.PlayerUID
            };
        }).ToArray() ?? [];
        var map = new { id = api.World.SavegameIdentifier, chunkSize = 32 };
        if (manager?.IsOpened != true) return new { ok = true, opened = false, mode = "closed", scanned = worldMapScanned, session = life.Session, map, players };
        string mode = manager.worldMapDlg.DialogType == EnumDialogType.HUD ? "minimap" : "world";
        if (mode != "world") return new { ok = true, opened = true, mode, scanned = worldMapScanned, session = life.Session, map, players };
        worldMapScanned = true;
        var position = api.World.Player.Entity.Pos;
        var origin = new Vec3d(position.X, position.Y, position.Z);
        var here = new Vec2f(); var east = new Vec2f(); var south = new Vec2f();
        manager.TranslateWorldPosToViewPos(origin, ref here);
        manager.TranslateWorldPosToViewPos(new Vec3d(origin.X + 100, origin.Y, origin.Z), ref east);
        manager.TranslateWorldPosToViewPos(new Vec3d(origin.X, origin.Y, origin.Z + 100), ref south);
        var bounds = manager.worldMapDlg?.SingleComposer?.GetElement("mapElem")?.Bounds;
        if (bounds == null) return new { ok = true, opened = true, mode, scanned = worldMapScanned, session = life.Session, map, players };
        float offsetX = (float)bounds.absX, offsetY = (float)bounds.absY;
        return new
        {
            ok = true,
            opened = true,
            mode,
            scanned = worldMapScanned,
            session = life.Session,
            map,
            players,
            observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            world = new { x = origin.X, z = origin.Z, dimension = position.Dimension },
            view = new
            {
                here = new[] { here.X + offsetX, here.Y + offsetY },
                east100 = new[] { east.X + offsetX, east.Y + offsetY },
                south100 = new[] { south.X + offsetX, south.Y + offsetY }
            }
        };
    }

    private object Sense(JsonElement request)
    {
        long cursor = 0;
        if (request.TryGetProperty("after", out var cursorField) && (!cursorField.TryGetInt64(out cursor) || cursor < 0))
            return new { ok = false, error = "Invalid terrain cursor." };
        string? terrainSession = request.TryGetProperty("session", out var terrainSessionField) && terrainSessionField.ValueKind == JsonValueKind.String
            ? terrainSessionField.GetString() : null;
        if (!TryWatch(request, out string? watchError)) return new { ok = false, error = watchError };
        lastSenseAt = Environment.TickCount64;
        return new { ok = true, state = Observe(),
            terrain = terrain.Read(cursor, terrainSession, lastSenseAt),
            surface = vision.Surface(lastSenseAt), sightings = vision.Sightings(lastSenseAt) };
    }

    // Other players on this server, from the same server-filtered feed the map
    // renders plus locally loaded player entities (a map-hidden player standing
    // here is still seen). Positions are exact when the entity is loaded,
    // tracking x/z at own height otherwise. Visible means inside the camera's
    // view cone within 64 blocks: directional only, not occlusion- or
    // light-tested. Solo servers return an empty list.
    private object Players()
    {
        var self = api.World.Player;
        var eye = self.Entity.Pos.XYZ.Add(self.Entity.LocalEyePos);
        var origin = new Point3(eye.X, eye.Y, eye.Z);
        double yaw = NormalizeDegrees(self.Entity.Pos.Yaw * 180 / Math.PI);
        double pitch = (self.Entity.Pos.Pitch - Math.PI) * 180 / Math.PI;
        var loaded = new Dictionary<string, Point3>();
        api.World.GetEntitiesAround(new Vec3d(origin.X, origin.Y, origin.Z), 64, 64, entity =>
        {
            if (entity is EntityPlayer player && player.PlayerUID != self.PlayerUID)
            {
                var p = player.Pos.XYZ;
                loaded[player.PlayerUID] = new Point3(p.X, p.Y, p.Z);
            }
            return true;
        });
        var seen = new HashSet<string>();
        var rows = new List<object>();
        var tracking = api.ModLoader.GetModSystem<SystemRemotePlayerTracking>();
        foreach (var packet in tracking?.GetAllTrackedPlayerPositions() ?? [])
        {
            if (packet.PlayerUid == self.PlayerUID || !seen.Add(packet.PlayerUid)) continue;
            var player = packet.AssociatedPlayer ?? api.World.PlayerByUid(packet.PlayerUid);
            var pos = loaded.TryGetValue(packet.PlayerUid, out var exact)
                ? exact : new Point3(packet.PosX, origin.Y, packet.PosZ);
            rows.Add(PlayerRow(player?.PlayerName ?? "Unknown player", packet.PlayerUid, pos, origin, yaw, pitch,
                loaded.ContainsKey(packet.PlayerUid)));
        }
        foreach (var (uid, pos) in loaded)
        {
            if (!seen.Add(uid)) continue;
            var player = api.World.PlayerByUid(uid);
            rows.Add(PlayerRow(player?.PlayerName ?? "Unknown player", uid, pos, origin, yaw, pitch, true));
        }
        return new { ok = true, players = rows.ToArray() };
    }

    private static object PlayerRow(string name, string uid, Point3 pos, Point3 origin, double yaw, double pitch, bool exact) => new
    {
        name, uid, x = pos.X, y = pos.Y, z = pos.Z,
        distance = Math.Round(SceneGeometry.Distance(origin, pos), 2),
        visible = exact && SceneGeometry.InCone(origin, pos, yaw, pitch, 64),
    };

    private object[] NearbyEntities(int limit = 24)
    {
        var entity = api.World!.Player.Entity;
        var eye = entity.Pos.XYZ.Add(entity.LocalEyePos);
        var origin = new Point3(eye.X, eye.Y, eye.Z);
        long now = Environment.TickCount64;
        return sightings.Current(now, "entity")
            .Select(pair => new { key = pair.Key, code = pair.Value.Code,
                point = new { x = pair.Value.Point.X, y = pair.Value.Point.Y, z = pair.Value.Point.Z },
                distance = Math.Round(SceneGeometry.Distance(origin, pair.Value.Point), 2),
                how = pair.Value.How, seenAt = pair.Value.At, visible = true })
            .OrderBy(sighting => sighting.distance).Take(limit).Cast<object>().ToArray();
    }

    // An optional watch list sets what blocks the eye is currently looking for.
    private bool TryWatch(JsonElement request, out string? error)
    {
        error = null;
        if (!request.TryGetProperty("watch", out var watchField)) return true;
        if (watchField.ValueKind != JsonValueKind.Array || watchField.GetArrayLength() > 16 ||
            watchField.EnumerateArray().Any(value => value.ValueKind != JsonValueKind.String || value.GetString()!.Length is < 1 or > 64))
        { error = "watch must be up to 16 strings of 1–64 characters."; return false; }
        vision.SetWatch(watchField.EnumerateArray().Select(value => value.GetString()!).ToArray());
        return true;
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

    private object Events(JsonElement request) =>
        ReadCursor(request, out long after, out string? session) is { } error ? new { ok = false, error } : life.Read(after, session);

    private object Messages(JsonElement request) =>
        ReadCursor(request, out long after, out string? session) is { } error ? new { ok = false, error } : chat.Read(after, session);

    private object CanSee(JsonElement request)
    {
        int[] cell = new int[3];
        string[] names = ["x", "y", "z"];
        for (int i = 0; i < 3; i++)
            if (!request.TryGetProperty(names[i], out var field) || field.ValueKind != JsonValueKind.Number || !field.TryGetInt32(out cell[i]))
                return new { ok = false, error = "Supply integer x, y and z." };
        return vision.CanSee(cell[0], cell[1], cell[2]);
    }

    // The bounded-ring cursor shared by events and messages: after (nonnegative) and session.
    private static string? ReadCursor(JsonElement request, out long after, out string? session)
    {
        after = 0; session = null;
        if (request.TryGetProperty("after", out var afterField) &&
            (afterField.ValueKind != JsonValueKind.Number || !afterField.TryGetInt64(out after) || after < 0))
            return "after must be a nonnegative integer.";
        if (request.TryGetProperty("session", out var sessionField))
        {
            if (sessionField.ValueKind != JsonValueKind.String || sessionField.GetString()!.Length > 64) return "Invalid event session.";
            session = sessionField.GetString();
        }
        return null;
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

    private object ItemInfo(JsonElement request)
    {
        if (!request.TryGetProperty("code", out var code) || code.ValueKind != JsonValueKind.String || code.GetString()!.Length is < 1 or > 128)
            return new { ok = false, error = "code must be 1–128 characters of item or block code." };
        return handbook.ItemInfo(code.GetString()!);
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
            // Death releases everything. Damage and life alerts are reported, not enforced: the brain
            // decides what being hurt means, and a frozen bot next to a bear is the worst policy.
            if (!entity.Alive) { ReleaseControl("dead"); StopMovement(); StopHandAction(); }
            ClearTargetLock();
        }
    }

    // The caller may request this narrow scope only for an explicit food
    // recovery episode. Keep low health tolerated after eating clears the
    // low-food alert so that the same episode can finish building a reserve.

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
