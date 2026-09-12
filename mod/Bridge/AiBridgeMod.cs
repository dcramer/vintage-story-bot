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

// Lifecycle, loopback transport and request dispatch. Game access happens on the game tick only.
public sealed partial class AiBridgeMod : ModSystem
{
    private const int Port = 42157;
    private readonly ConcurrentQueue<PendingRequest> requests = new();
    private ICoreClientAPI api = null!;
    private CancellationTokenSource? lifetime;
    private TcpListener? listener;
    private DialogAdapter dialogs = null!;
    private PausedDispatcher? pausedDispatcher;
    private long tickListener;
    private SceneSensor sensor = null!;
    private readonly SurfaceMap surface = new(30000, 96);
    private readonly SightingsMap sightings = new();
    private VisionSensor vision = null!;
    private long lastSenseAt;
    private LifeTracker life = new();
    private InventoryAdapter inventory = null!;
    private ContainerAdapter containers = null!;
    private float lastTickDt;
    private ContextSensor context = null!;
    private HandbookSensor handbook = null!;
    private BlockActions blockActions = null!;
    private readonly TerrainMap terrain = new(16384, 120000, 64);
    private TerrainSensor terrainSensor = null!;
    private MapWaypointSensor mapWaypoints = null!;

    public override bool ShouldLoad(EnumAppSide forSide) => forSide == EnumAppSide.Client;

    public override void StartClientSide(ICoreClientAPI api)
    {
        this.api = api;
        control.Release("world_changed");
        terrainSensor = new TerrainSensor(api, terrain);
        api.Event.BlockChanged += terrainSensor.Changed;
        api.Input.InWorldAction += RetainOwnedMovement;
        sensor = new SceneSensor(api, CanControl);
        vision = new VisionSensor(api, surface, sightings);
        inventory = new InventoryAdapter(api);
        containers = new ContainerAdapter(api);
        context = new ContextSensor(api);
        handbook = new HandbookSensor(api);
        mapWaypoints = new MapWaypointSensor(api);
        blockActions = new BlockActions(api);
        dialogs = new DialogAdapter(api);
        api.Event.BlockChanged += blockActions.Changed;
        tickListener = api.Event.RegisterGameTickListener(OnTick, 20);
        pausedDispatcher = new PausedDispatcher(this);
        api.Event.RegisterRenderer(pausedDispatcher, EnumRenderStage.Done, "aibridge-paused");
        api.Event.LevelFinalize += OnLevelReady;
        api.Event.LeaveWorld += OnLeaveWorld;
    }

    private void OnLeaveWorld()
    {
        StopBridge();
        StopListener();
    }

    private void OnLevelReady()
    {
        worldInteractions = (api.World as ClientMain)?.clientSystems
            .OfType<SystemMouseInWorldInteractions>().FirstOrDefault();
        sensor.Reset();
        vision.Reset();
        terrainSensor.Reset();
        control.Release("world_changed");
        life = new LifeTracker();
        inventory = new InventoryAdapter(api);
        containers = new ContainerAdapter(api);
        blockActions.Reset();
        SampleLife();
        // The bridge controls this client whenever a world is loaded; there is no in-game opt-in.
        string? failure = StartListener();
        if (failure != null) api.Logger.Error($"[AI bridge] {failure}");
        api.ShowChatMessage(failure ?? $"Seraph bridge listening on 127.0.0.1:{Port}.");
    }

    private string? StartListener()
    {
        if (lifetime != null) return null;
        var server = new TcpListener(IPAddress.Loopback, Port);
        try { server.Start(); }
        catch (SocketException exception)
        {
            return $"Cannot open AI bridge: {exception.Message}";
        }
        listener = server;
        lifetime = new CancellationTokenSource();
        _ = ServeAsync(server, lifetime.Token);
        return null;
    }

    private void StopListener()
    {
        lifetime?.Cancel();
        listener?.Stop();
        lifetime?.Dispose();
        lifetime = null;
        listener = null;
        while (requests.TryDequeue(out var pending)) pending.Completion.TrySetCanceled();
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
        lastTickDt = dt;
        priorWorldInteraction ??= api.Input.MouseWorldInteractAnyway;
        bool ready = CanControl();
        api.Input.MouseWorldInteractAnyway = ready;
        if (ready && api.World is ClientMain client)
        {
            // Center the game's picking ray, not the OS pointer. Normal interactions/packets still apply.
            client.MouseCurrentX = client.Width / 2;
            client.MouseCurrentY = client.Height / 2;
        }
        SampleLife();

        DrainRequests();

        if (CanControl())
        {
            try
            {
                long now = Environment.TickCount64;
                if (control.Active && (ManualInput() || control.Expire(now))) ReleaseControl(ManualInput() ? "manual_input" : "expired");
                terrainSensor.Sample(now, sensorPriority);
                // Far view vision streams only while a controller is reading it.
                if (now - lastSenseAt < 5000) vision.Sample(now);
                UpdateTargetLock();
                if (control.Active || lockKind != LockKind.None) ApplyCamera(dt);
            }
            catch (Exception exception)
            {
                ReleaseControl("sensor_error");
                StopMovement();
                api.Logger.Error($"AI navigation failed: {exception}");
            }
        }
        else
        {
            if (control.Active) ReleaseControl("control_unavailable");
            ClearTargetLock();
        }
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

    // Judge control hold refreshes when the bridge received them, before expiring the
    // owner on a delayed render tick. Requests cancelled by the network timeout
    // are still discarded and cannot revive control.
    private void DrainRequests()
    {
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
    }

    // Game ticks stop while singleplayer is paused (pause menu, character creation), but the GUI still renders on
    // the same main thread; serve observe/dialog requests from there so blocking dialogs can be handled.
    private sealed class PausedDispatcher(AiBridgeMod mod) : IRenderer
    {
        public double RenderOrder => 1;
        public int RenderRange => 0;
        public void OnRenderFrame(float deltaTime, EnumRenderStage stage) { if (mod.api.IsGamePaused) mod.DrainRequests(); }
        public void Dispose() { }
    }

    private object Execute(string json, long? receivedAt = null)
    {
        using var document = JsonDocument.Parse(json);
        var request = document.RootElement;
        if (request.ValueKind != JsonValueKind.Object || !request.TryGetProperty("action", out var action) || action.ValueKind != JsonValueKind.String)
            return new { ok = false, error = "Expected an action string." };
        if (api.World?.Player?.Entity == null)
            return new { ok = false, error = "Bridge requires an active world." };
        string name = action.GetString()!;
        if (Mutations.Contains(name))
        {
            if (name != "stop" && control.Active)
                return new { ok = false, error = "Controller owns inputs; stop it before another mutation." };
            if (name == "stop") ReleaseControl("stopped");
        }
        // One case per wire action; bodies live in the partial file owning that concern.
        switch (name)
        {
            case "observe": return Observe();
            case "sense": return Sense(request);
            case "scan": return Scan(request);
            case "inspect_target": return CanControl() ? context.InspectTarget(life.Session) : new { ok = false, error = "Close menus and unpause before inspecting." };
            case "environment": return context.Environment(life.Session);
            case "events": return Events(request);
            case "respawn": return Respawn(request);
            case "ui_dialogs": return dialogs.Observe();
            case "ui_activate": return dialogs.Activate(request);
            case "inventory": return inventory.Observe();
            case "recipes": return Recipes(request);
            case "item_info": return ItemInfo(request);
            case "inventory_move":
            case "craft": return InventoryMove(name, request);
            case "drop": return InventoryDrop(request);
            case "open_container": return OpenContainer(request);
            case "container_move": return ContainerMove(request);
            case "close_container": return CloseContainer(request);
            case "container_slots": return containers.Read();
            case "select": return SelectHotbar(request);
            case "select_recipe": return context.Forming.SelectRecipe(request);
            case "interact":
            case "attack": return HandAction(name, request);
            case "block_action_begin": return BlockActionBegin(request);
            case "block_action_continue": return blockActions.Read(request, true);
            case "block_action_status": return blockActions.Read(request, false);
            case "chat": return Chat(request);
            case "map_waypoints": return mapWaypoints.Observe();
            case "map_waypoint_remove": return MapWaypointRemove(request);
            case "map_view": return MapView();
            case "players": return Players();
            case "look": return Look(request);
            case "look_at": return LookAt(request);
            case "aim_cell": return AimCell(request);
            case "move": return Move(request);
            case "control_begin": return ControlBegin(request);
            case "control_end": return ControlEnd(request);
            case "control_frame":
            case "control_step": return ControlFrame(name, request, receivedAt);
            case "stop":
                StopMovement();
                StopHandAction();
                ClearTargetLock();
                return new { ok = true, status = "stopped" };
            default:
                return new { ok = false, error = "Unknown action. Use observe, events, respawn, scan, look, select, move, interact, attack, or stop." };
        }
    }

    // Wire actions refused while a control hold owns the inputs; stop releases it first.
    private static readonly HashSet<string> Mutations = ["move_to", "move", "look", "aim_cell", "select", "interact", "attack", "stop", "respawn", "craft", "inventory_move", "drop", "open_container", "container_move", "close_container", "look_at", "block_action_begin", "block_action_continue", "select_recipe", "ui_activate"];
    private bool CanControl() => api.World?.Player?.Entity?.Alive == true && !api.IsGamePaused &&
        !api.Gui.OpenedGuis.Any(dialog => dialog.IsOpened() && DialogAdapter.BlocksControl(dialog));

    // Releases every owned input; runs on world exit and mod disposal.
    private void StopBridge()
    {
        ReleaseControl("bridge_off");
        terrainSensor?.Reset();
        sensor?.Reset();
        vision?.Reset();
        StopMovement();
        StopHandAction();
        if (priorWorldInteraction.HasValue)
        {
            api.Input.MouseWorldInteractAnyway = priorWorldInteraction.Value;
            priorWorldInteraction = null;
        }
    }

    public override void Dispose()
    {
        StopBridge();
        StopListener();
        if (api != null)
        {
            api.Event.UnregisterGameTickListener(tickListener);
            if (pausedDispatcher != null) api.Event.UnregisterRenderer(pausedDispatcher, EnumRenderStage.Done);
            api.Event.LevelFinalize -= OnLevelReady;
            api.Event.LeaveWorld -= OnLeaveWorld;
            api.Event.BlockChanged -= terrainSensor.Changed;
            api.Event.BlockChanged -= blockActions.Changed;
            api.Input.InWorldAction -= RetainOwnedMovement;
        }
        base.Dispose();
    }

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

    private static double NormalizeDegrees(double degrees) => (degrees % 360 + 360) % 360;

    private sealed record PendingRequest(string Json, long ReceivedAt, CancellationToken Cancellation, TaskCompletionSource<object> Completion);
}
