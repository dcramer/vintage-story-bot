using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Vintagestory.API.Client;
using Vintagestory.API.Common;
using Vintagestory.API.Config;
using Vintagestory.Client.NoObf;

namespace VintageStoryAI;

public sealed class AiBridgeMod : ModSystem
{
    private const int Port = 42157;
    private readonly ConcurrentQueue<PendingRequest> requests = new();
    private ICoreClientAPI api = null!;
    private CancellationTokenSource? lifetime;
    private TcpListener? listener;
    private long tickListener;
    private EntityControls? movingControls;
    private int[] movingKeys = [];
    private string moveDirection = "forward";
    private bool moveJump;
    private bool moveSprint;
    private bool moveSneak;
    private bool handSneak;
    private long stopAt;
    private string? handAction;
    private string? handTarget;
    private int? handSlot;
    private string? handItem;
    private long handStopAt;
    private SceneSensor sensor = null!;
    private SystemMouseInWorldInteractions? worldInteractions;
    private LifeTracker life = new();
    private InventoryAdapter inventory = null!;
    private ContextSensor context = null!;
    private BlockActions blockActions = null!;
    private bool? priorWorldInteraction;
    private readonly TerrainMap terrain = new(16384, 120000, 64);
    private readonly ControlLease control = new();
    private double controlYaw, controlPitch;
    private Cell? sensorPriority;
    private TerrainSensor terrainSensor = null!;

    public override bool ShouldLoad(EnumAppSide forSide) => forSide == EnumAppSide.Client;

    public override void StartClientSide(ICoreClientAPI api)
    {
        this.api = api;
        control.Revoke("world_changed");
        terrainSensor = new TerrainSensor(api, terrain);
        api.Event.BlockChanged += terrainSensor.Changed;
        api.Input.InWorldAction += RetainOwnedMovement;
        sensor = new SceneSensor(api, CanControl);
        inventory = new InventoryAdapter(api);
        context = new ContextSensor(api);
        blockActions = new BlockActions(api);
        api.Event.BlockChanged += blockActions.Changed;
        api.ChatCommands.Create("aibridge")
            .WithDescription("Control the local AI bridge")
            .HandleWith(_ => TextCommandResult.Success("Use .aibridge on to enable, or .aibridge off to stop. F7 enables; F8 stops."))
            .BeginSubCommand("on")
                .WithDescription("Enable control of this client's player")
                .HandleWith(_ => StartBridge())
            .EndSubCommand()
            .BeginSubCommand("off")
                .WithDescription("Stop movement and disable the bridge")
                .HandleWith(_ => { StopBridge(); return TextCommandResult.Success("AI bridge off."); })
            .EndSubCommand();

        api.Input.RegisterHotKey("aibridgestart", "Enable AI bridge", GlKeys.F7, HotkeyType.GUIOrOtherControls);
        api.Input.SetHotKeyHandler("aibridgestart", _ =>
        {
            api.ShowChatMessage(StartBridge().StatusMessage);
            return true;
        });
        api.Input.RegisterHotKey("aibridgestop", "Stop AI bridge", GlKeys.F8, HotkeyType.GUIOrOtherControls);
        api.Input.SetHotKeyHandler("aibridgestop", _ =>
        {
            StopBridge();
            api.ShowChatMessage("AI bridge off.");
            return true;
        });
        tickListener = api.Event.RegisterGameTickListener(OnTick, 20);
        api.Logger.Notification("[AI bridge] Registered .aibridge, F7 enable, F8 stop.");
        api.Event.LevelFinalize += OnLevelReady;
        api.Event.LeaveWorld += StopBridge;
    }

    private void OnLevelReady()
    {
        worldInteractions = (api.World as ClientMain)?.clientSystems
            .OfType<SystemMouseInWorldInteractions>().FirstOrDefault();
        sensor.Reset();
        terrainSensor.Reset();
        control.Revoke("world_changed");
        life = new LifeTracker();
        inventory = new InventoryAdapter(api);
        blockActions.Reset();
        SampleLife();
        bool registered = api.ChatCommands.Get("aibridge") != null;
        api.Logger.Notification($"[AI bridge] World ready; command registered: {registered}");
        api.ShowChatMessage(lifetime == null
            ? "Diggy bridge ready. F7 enables bot control; F8 stops and disables it."
            : "Diggy bridge enabled. F8 stops and disables bot control.");
    }

    private TextCommandResult StartBridge()
    {
        if (api.World?.Player?.Entity == null)
            return TextCommandResult.Error("Join your server or enter a test world first.");
        if (lifetime != null) return TextCommandResult.Success("AI bridge is already on.");

        var server = new TcpListener(IPAddress.Loopback, Port);
        try { server.Start(); }
        catch (SocketException exception)
        {
            return TextCommandResult.Error($"Cannot open AI bridge: {exception.Message}");
        }
        listener = server;
        lifetime = new CancellationTokenSource();
        _ = ServeAsync(server, lifetime.Token);
        return TextCommandResult.Success($"AI bridge listening on 127.0.0.1:{Port}. F8 stops it.");
    }

    // Networking only queues requests. All game access happens in OnTick.
    private async Task ServeAsync(TcpListener server, CancellationToken stopped)
    {
        try
        {
            while (!stopped.IsCancellationRequested)
            {
                using var client = await server.AcceptTcpClientAsync(stopped).ConfigureAwait(false);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stopped);
                timeout.CancelAfter(TimeSpan.FromSeconds(3));
                try
                {
                    var stream = client.GetStream();
                    // One small JSON line per connection; cap memory and connection lifetime.
                    var buffer = new byte[1024];
                    int length = 0;
                    while (length < buffer.Length)
                    {
                        int count = await stream.ReadAsync(buffer.AsMemory(length, 1), timeout.Token).ConfigureAwait(false);
                        if (count == 0 || buffer[length] == (byte)'\n') break;
                        length++;
                    }
                    object response;
                    if (length == buffer.Length)
                        response = new { ok = false, error = "Request exceeds 1023 bytes." };
                    else
                    {
                        var completion = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
                        requests.Enqueue(new(Encoding.UTF8.GetString(buffer, 0, length), Environment.TickCount64, timeout.Token, completion));
                        response = await completion.Task.WaitAsync(timeout.Token).ConfigureAwait(false);
                    }
                    byte[] output = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(response) + "\n");
                    await stream.WriteAsync(output, timeout.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) { }
                catch (IOException) { }
                catch (SocketException) { }
            }
        }
        catch (OperationCanceledException) when (stopped.IsCancellationRequested) { }
        catch (SocketException) when (stopped.IsCancellationRequested) { }
        catch (ObjectDisposedException) when (stopped.IsCancellationRequested) { }
    }

    private void OnTick(float dt)
    {
        if (lifetime != null)
        {
            priorWorldInteraction ??= api.Input.MouseWorldInteractAnyway;
            bool ready = CanControl();
            api.Input.MouseWorldInteractAnyway = ready;
            if (ready && api.World is ClientMain client)
            {
                // Center the game's picking ray, not the OS pointer. Normal interactions/packets still apply.
                client.MouseCurrentX = client.Width / 2;
                client.MouseCurrentY = client.Height / 2;
            }
        }
        SampleLife();

        // Judge lease refreshes when the bridge received them, before expiring the
        // owner on a delayed render tick. Requests cancelled by the network timeout
        // are still discarded and cannot revive control.
        while (requests.TryDequeue(out var pending))
        {
            if (pending.Cancellation.IsCancellationRequested) continue;
            try { pending.Completion.TrySetResult(Execute(pending.Json, pending.ReceivedAt)); }
            catch (JsonException) { pending.Completion.TrySetResult(new { ok = false, error = "Invalid JSON request." }); }
            catch (Exception exception)
            {
                ReleaseControl("action_error");
                StopMovement();
                StopHandAction();
                api.Logger.Error($"AI bridge request failed: {exception}");
                pending.Completion.TrySetResult(new { ok = false, error = "Game action failed; see client log." });
            }
        }

        if (lifetime != null && CanControl())
        {
            try
            {
                long now = Environment.TickCount64;
                if (control.Active && (ManualInput() || control.Expire(now))) ReleaseControl(ManualInput() ? "manual_input" : "expired");
                terrainSensor.Sample(now, sensorPriority);
                if (control.Active) ApplyCamera(dt);
            }
            catch (Exception exception)
            {
                ReleaseControl("sensor_error");
                StopMovement();
                api.Logger.Error($"AI navigation failed: {exception}");
            }
        }
        else if (control.Active) ReleaseControl("control_unavailable");
        blockActions.Tick(CanControl() && !ManualInput() && !NavigationDanger(blockActions.StarvingRecovery) &&
            api.World.Player.Entity.OnGround && !api.World.Player.Entity.FeetInLiquid);
        if (handAction != null)
        {
            if (Environment.TickCount64 >= handStopAt || api.IsGamePaused ||
                !CanControl() ||
                handTarget != CurrentTargetKey() ||
                (handSlot != null && (handSlot != api.World.Player.InventoryManager.ActiveHotbarSlotNumber ||
                    handItem != api.World.Player.InventoryManager.ActiveHotbarSlot.Itemstack?.Collectible.Code.ToString())))
                StopHandAction();
            else
                SetHandButtons();
        }
        // Vanilla advances block/hand interactions from its final render pass. On a
        // software-rendered or occluded client that pass can run far below the game
        // tick rate, leaving a normal held click unable to make progress. Drive the
        // same vanilla interaction system from the game tick while the bridge owns a
        // hand action; elapsed game time still determines break/use speed and the
        // usual callbacks, access checks and multiplayer packets remain authoritative.
        if ((blockActions.Digging || handAction != null) && api.World is ClientMain interactionClient)
        {
            worldInteractions ??= interactionClient.clientSystems.OfType<SystemMouseInWorldInteractions>().FirstOrDefault();
            worldInteractions?.OnFinalizeFrame(dt);
        }
        if (movingControls != null)
        {
            if (Environment.TickCount64 >= stopAt || !CanControl())
                StopMovement();
            else
                SetMovement(true);
        }

    }

    private object Execute(string json, long? receivedAt = null)
    {
        using var document = JsonDocument.Parse(json);
        var request = document.RootElement;
        if (request.ValueKind != JsonValueKind.Object || !request.TryGetProperty("action", out var action) || action.ValueKind != JsonValueKind.String)
            return new { ok = false, error = "Expected an action string." };

        var entity = api.World?.Player?.Entity;
        if (lifetime == null || entity == null)
            return new { ok = false, error = "Bridge requires an active world." };

        if (action.GetString() is "move_to" or "move" or "look" or "select" or "interact" or "attack" or "stop" or "respawn" or "craft" or "inventory_move" or "block_action_begin" or "block_action_continue" or "select_recipe")
        {
            if (action.GetString() != "stop" && control.Active)
                return new { ok = false, error = "Controller owns inputs; stop it before another mutation." };
            if (action.GetString() == "stop") ReleaseControl("stopped");
        }

        switch (action.GetString())
        {
            case "observe":
                var pos = entity.Pos;
                return new
                {
                    ok = true,
                    capabilities = new[] { "target_guard", "directional_move", "scan", "nearby_awareness", "distant_sight", "environment", "player_condition", "inspect_target", "equipment", "forage_state", "food_freshness", "life_events", "respawn", "inventory", "grid_craft", "background_control", "control_frames", "terrain_deltas", "background_jump", "background_sprint", "block_actions", "sneak", "forming", "chat" },
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
            case "inventory":
                return inventory.Observe();
            case "inventory_move":
            case "craft":
                StopMovement();
                StopHandAction();
                return inventory.Move(request, action.GetString() == "craft");
            case "recipes":
                if (!request.TryGetProperty("match", out var recipeMatch) || recipeMatch.ValueKind != JsonValueKind.String ||
                    recipeMatch.GetString()!.Length is < 1 or > 64)
                    return new { ok = false, error = "Recipe match must be 1–64 characters of output code." };
                int offset = 0, recipeLimit = 4;
                if (request.TryGetProperty("offset", out _) && (!TryInteger(request, "offset", out offset) || offset < 0 || offset > 100000) ||
                    request.TryGetProperty("limit", out _) && (!TryInteger(request, "limit", out recipeLimit) || recipeLimit < 1 || recipeLimit > 8))
                    return new { ok = false, error = "offset: 0–100000; limit: 1–8." };
                return inventory.Recipes(recipeMatch.GetString()!, offset, recipeLimit);
            case "environment":
                return context.Environment(life.Session);
            case "select_recipe":
                return context.Forming.SelectRecipe(request);
            case "inspect_target":
                return CanControl() ? context.InspectTarget(life.Session) : new { ok = false, error = "Close menus and unpause before inspecting." };
            case "block_action_begin":
                bool blockRecovery = request.TryGetProperty("allowStarvingRecovery", out var blockRecoveryField) &&
                    blockRecoveryField.ValueKind == JsonValueKind.True;
                if (request.TryGetProperty("allowStarvingRecovery", out blockRecoveryField) &&
                    blockRecoveryField.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    return new { ok = false, error = "allowStarvingRecovery must be boolean." };
                if (!CanControl() || ManualInput() || NavigationDanger(blockRecovery) || !entity.OnGround || entity.FeetInLiquid || entity.MountedOn != null)
                    return new { ok = false, error = "Block actions need grounded, dry, ready controls." };
                StopMovement(); StopHandAction();
                return blockActions.Begin(request, inventory, blockRecovery);
            case "block_action_continue":
                return blockActions.Read(request, true);
            case "block_action_status":
                return blockActions.Read(request, false);
            case "events":
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
            case "respawn":
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
            case "scan":
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
            case "look":
                if (!TryNumber(request, "yawDegrees", out double yaw) ||
                    !TryNumber(request, "pitchDegrees", out double pitch) || pitch < -89 || pitch > 89 || Math.Abs(yaw) > 36000)
                    return new { ok = false, error = "Supply finite yawDegrees (-36000 to 36000) and pitchDegrees (-89 up to 89 down)." };
                if (!entity.Alive || api.IsGamePaused)
                    return new { ok = false, error = "Cannot look while dead or paused." };
                StopHandAction();
                api.Input.MouseYaw = entity.Pos.Yaw = (float)(NormalizeDegrees(yaw) * Math.PI / 180);
                api.Input.MousePitch = entity.Pos.Pitch = (float)(Math.PI + pitch * Math.PI / 180);
                return new { ok = true, status = "looking", yawDegrees = NormalizeDegrees(yaw), pitchDegrees = pitch };
            case "select":
                var hotbar = api.World!.Player.InventoryManager.GetHotbarInventory();
                if (!TryInteger(request, "slot", out int slot) || hotbar == null || slot < 0 || slot > 9 || slot >= hotbar.Count)
                    return new { ok = false, error = "Select ordinary hotbar slots 0–9; extra/offhand slots are not selection indices." };
                if (!entity.Alive || api.IsGamePaused)
                    return new { ok = false, error = "Cannot select while dead or paused." };
                StopHandAction();
                api.World.Player.InventoryManager.ActiveHotbarSlotNumber = slot;
                return new { ok = true, activeSlot = slot };
            case "interact":
            case "attack":
                if (!TryInteger(request, "durationMs", out int handMilliseconds) || handMilliseconds < 1 || handMilliseconds > 2000)
                    return new { ok = false, error = "durationMs must be an integer from 1 to 2000." };
                if (!CanControl())
                    return new { ok = false, error = "Close menus and enter the world before interacting." };
                if (request.TryGetProperty("expectedTarget", out var expected) &&
                    (expected.ValueKind is not (JsonValueKind.String or JsonValueKind.Null) || expected.GetString() != CurrentTargetKey()))
                {
                    StopMovement();
                    StopHandAction();
                    return new { ok = false, error = "Target changed; observe and aim again." };
                }
                if (request.TryGetProperty("expectedState", out var expectedInventory) &&
                    (expectedInventory.ValueKind != JsonValueKind.String || !inventory.Matches(expectedInventory.GetString())))
                    return new { ok = false, error = "Inventory changed; inspect before interacting." };
                if (request.TryGetProperty("expectedItem", out var expectedItem) &&
                    (expectedItem.ValueKind != JsonValueKind.Object || !TryInteger(expectedItem, "slot", out int itemSlot) ||
                     itemSlot != api.World!.Player.InventoryManager.ActiveHotbarSlotNumber ||
                     !expectedItem.TryGetProperty("code", out var itemCode) || itemCode.ValueKind is not (JsonValueKind.String or JsonValueKind.Null) ||
                     itemCode.GetString() != api.World.Player.InventoryManager.ActiveHotbarSlot.Itemstack?.Collectible.Code.ToString()))
                    return new { ok = false, error = "Held item changed; inspect before interacting." };
                if (action.GetString() == "attack" && api.World!.Player.CurrentBlockSelection == null)
                    return new { ok = false, error = "Aim at a block before attacking; entity combat is not supported yet." };
                bool sneakHand = false;
                if (request.TryGetProperty("sneak", out var handSneakField))
                {
                    if (handSneakField.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                        return new { ok = false, error = "sneak must be boolean." };
                    sneakHand = handSneakField.GetBoolean();
                }
                StopMovement();
                StopHandAction();
                handSneak = sneakHand;
                handAction = action.GetString();
                handTarget = CurrentTargetKey();
                handSlot = api.World!.Player.InventoryManager.ActiveHotbarSlotNumber;
                handItem = api.World.Player.InventoryManager.ActiveHotbarSlot.Itemstack?.Collectible.Code.ToString();
                handStopAt = Environment.TickCount64 + handMilliseconds;
                SetHandButtons();
                return new { ok = true, status = "started", durationMs = handMilliseconds };
            case "chat":
                if (!request.TryGetProperty("message", out var chatField) || chatField.ValueKind != JsonValueKind.String)
                    return new { ok = false, error = "Supply a message string." };
                var chatText = chatField.GetString()!.Replace('\n', ' ').Replace('\r', ' ').Trim();
                // Never let generated status text be interpreted as a chat command.
                while (chatText.Length > 0 && (chatText[0] == '/' || chatText[0] == '.')) chatText = chatText[1..].TrimStart();
                if (chatText.Length == 0) return new { ok = false, error = "Empty chat message." };
                if (chatText.Length > 256) chatText = chatText[..256];
                api.SendChatMessage(chatText, GlobalConstants.GeneralChatGroup, null);
                return new { ok = true, status = "sent", message = chatText };
            case "sense":
                long cursor = 0;
                if (request.TryGetProperty("after", out var cursorField) && (!cursorField.TryGetInt64(out cursor) || cursor < 0))
                    return new { ok = false, error = "Invalid terrain cursor." };
                string? terrainSession = request.TryGetProperty("session", out var terrainSessionField) && terrainSessionField.ValueKind == JsonValueKind.String
                    ? terrainSessionField.GetString() : null;
                return new { ok = true, state = Execute("""{"action":"observe"}"""),
                    terrain = terrain.Read(cursor, terrainSession, Environment.TickCount64) };
            case "control_begin":
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
            case "control_end":
                if (!request.TryGetProperty("owner", out var endOwner) || endOwner.GetString() != control.Owner || !control.Active)
                    return new { ok = false, error = "Not the input owner." };
                ReleaseControl("released");
                return new { ok = true, status = "stopped" };
            case "control_frame":
            case "control_step":
                bool includeSense = action.GetString() == "control_step";
                long stepCursor = 0;
                string? stepSession = null;
                if (includeSense)
                {
                    if (request.TryGetProperty("after", out var stepCursorField) && (!stepCursorField.TryGetInt64(out stepCursor) || stepCursor < 0))
                        return new { ok = false, error = "Invalid terrain cursor." };
                    stepSession = request.TryGetProperty("session", out var stepSessionField) && stepSessionField.ValueKind == JsonValueKind.String
                        ? stepSessionField.GetString() : null;
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
                    moveJump = jumping; moveSprint = sprinting && frameForward && !frameSneak; moveSneak = frameSneak; stopAt = control.Until; SetMovement(true);
                }
                if (includeSense)
                    return new { ok = true, sequence, state = Execute("""{"action":"observe"}"""),
                        terrain = terrain.Read(stepCursor, stepSession, Environment.TickCount64) };
                return new { ok = true, sequence };
            case "move":
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
            case "stop":
                StopMovement();
                StopHandAction();
                return new { ok = true, status = "stopped" };
            default:
                return new { ok = false, error = "Unknown action. Use observe, events, respawn, scan, look, select, move, interact, attack, or stop." };
        }
    }

    private static double NormalizeDegrees(double degrees) => (degrees % 360 + 360) % 360;

    private bool CanControl() => lifetime != null && api.World?.Player?.Entity?.Alive == true && !api.IsGamePaused &&
        !api.Gui.OpenedGuis.Any(dialog => dialog.IsOpened() &&
            (dialog.DialogType == EnumDialogType.Dialog || dialog.CaptureAllInputs() || dialog.DisableMouseGrab));

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

    private bool NavigationDanger(bool starvingRecovery = false) => life.Alerts.Any(alert => alert != "low_food" &&
        !(alert == "low_health" && starvingRecovery && life.Alerts.Contains("low_food")));

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

    private static bool TryNumber(JsonElement request, string name, out double value)
    {
        value = 0;
        return request.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.Number &&
            field.TryGetDouble(out value) && double.IsFinite(value);
    }

    private static bool TryInteger(JsonElement request, string name, out int value)
    {
        value = 0;
        return request.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.Number && field.TryGetInt32(out value);
    }

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

    private void SetHandButtons()
    {
        // The game's interaction system reads these states and performs the usual
        // item/block callbacks and multiplayer packets, including break duration.
        api.Input.InWorldMouseButton.Left = handAction == "attack";
        api.Input.InWorldMouseButton.Right = handAction == "interact";
        if (handSneak) SetSneak(api.World.Player.Entity.Controls, true);
    }

    private static void SetSneak(EntityControls controls, bool pressed)
    {
        // ShiftKey is the interaction modifier (ground placement, knapping, clay forming); Sneak is the motion state.
        controls.Sneak = pressed;
        controls.ShiftKey = pressed;
    }

    private void StopHandAction()
    {
        blockActions?.Cancel("stopped");
        if (handAction != null)
        {
            api.Input.InWorldMouseButton.Left = false;
            api.Input.InWorldMouseButton.Right = false;
            if (handSneak && !moveSneak && api.World?.Player?.Entity != null) SetSneak(api.World.Player.Entity.Controls, false);
        }
        handSneak = false;
        handAction = null;
        handTarget = null;
        handSlot = null;
        handItem = null;
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

    private void StopBridge()
    {
        ReleaseControl("bridge_off");
        terrainSensor?.Reset();
        sensor?.Reset();
        StopMovement();
        StopHandAction();
        if (priorWorldInteraction.HasValue)
        {
            api.Input.MouseWorldInteractAnyway = priorWorldInteraction.Value;
            priorWorldInteraction = null;
        }
        lifetime?.Cancel();
        listener?.Stop();
        lifetime?.Dispose();
        lifetime = null;
        listener = null;
        while (requests.TryDequeue(out var pending)) pending.Completion.TrySetCanceled();
    }

    public override void Dispose()
    {
        StopBridge();
        if (api != null)
        {
            api.Event.UnregisterGameTickListener(tickListener);
            api.Event.LevelFinalize -= OnLevelReady;
            api.Event.LeaveWorld -= StopBridge;
            api.Event.BlockChanged -= terrainSensor.Changed;
            api.Event.BlockChanged -= blockActions.Changed;
            api.Input.InWorldAction -= RetainOwnedMovement;
        }
        base.Dispose();
    }

    private sealed record PendingRequest(string Json, long ReceivedAt, CancellationToken Cancellation, TaskCompletionSource<object> Completion);
}
