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
    private ChatSensor chat = new();
    private bool worldMapScanned;

    public override bool ShouldLoad(EnumAppSide forSide) => forSide == EnumAppSide.Client;

    public override void StartClientSide(ICoreClientAPI api)
    {
        this.api = api;
        control.Release("world_changed");
        terrainSensor = new TerrainSensor(api, terrain, sightings);
        api.Event.BlockChanged += terrainSensor.Changed;
        api.Input.InWorldAction += RetainOwnedMovement;
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
        api.Event.ChatMessage += (group, message, type, _) => chat.Add(Environment.TickCount64, group, message, type.ToString());
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
        vision.Reset();
        terrainSensor.Reset();
        control.Release("world_changed");
        life = new LifeTracker();
        chat = new ChatSensor();
        inventory = new InventoryAdapter(api);
        containers = new ContainerAdapter(api);
        blockActions.Reset();
        worldMapScanned = false;
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
        Interlocked.Exchange(ref lastTickAt, 0);
        while (requests.TryDequeue(out var pending)) pending.Completion.TrySetCanceled();
    }

    // Networking only queues requests. All game access happens in OnTick.
    // A connection lives as long as the client keeps it: JSON lines in, JSON lines out, many in
    // flight at once; a request carrying a requestId gets it echoed on its reply so the client can pair
    // them out of order. A request the tick cannot answer within its deadline is refused, never
    // dropped, and one that arrives while the game thread has not ticked for a second is refused
    // at once from here, so a stalled client is told apart from a slow one.
    private const int RequestMaxBytes = 1024;
    private const long RequestDeadlineMs = 3000, StallMs = 1000;
    private long lastTickAt;

    private async Task ServeAsync(TcpListener server, CancellationToken stopped)
    {
        try
        {
            while (!stopped.IsCancellationRequested)
            {
                var client = await server.AcceptTcpClientAsync(stopped).ConfigureAwait(false);
                _ = ServeConnectionAsync(client, stopped);
            }
        }
        catch (OperationCanceledException) when (stopped.IsCancellationRequested) { }
        catch (SocketException) when (stopped.IsCancellationRequested) { }
        catch (ObjectDisposedException) when (stopped.IsCancellationRequested) { }
    }

    private async Task ServeConnectionAsync(TcpClient client, CancellationToken stopped)
    {
        using var connection = client;
        using var closed = CancellationTokenSource.CreateLinkedTokenSource(stopped);
        var writes = new SemaphoreSlim(1, 1);
        NetworkStream stream;
        try { stream = client.GetStream(); } catch (Exception) { return; }
        async Task Reply(string json, string? id)
        {
            // The requestId is spliced in front of the serialized reply so no response type has to carry it.
            string line = id == null || json.Length < 2 || json[0] != '{' ? json
                : "{\"requestId\":" + id + (json.Length > 2 ? "," : "") + json[1..];
            byte[] output = Encoding.UTF8.GetBytes(line + "\n");
            await writes.WaitAsync(closed.Token).ConfigureAwait(false);
            try { await stream.WriteAsync(output, closed.Token).ConfigureAwait(false); }
            finally { writes.Release(); }
        }
        try
        {
            var buffer = new byte[4096];
            var line = new List<byte>(RequestMaxBytes);
            bool overflow = false;
            while (!closed.IsCancellationRequested)
            {
                int count = await stream.ReadAsync(buffer, closed.Token).ConfigureAwait(false);
                if (count == 0) break;
                for (int i = 0; i < count; i++)
                {
                    if (buffer[i] != (byte)'\n')
                    {
                        if (line.Count < RequestMaxBytes) line.Add(buffer[i]); else overflow = true;
                        continue;
                    }
                    string json = Encoding.UTF8.GetString(line.ToArray());
                    bool tooLong = overflow;
                    line.Clear(); overflow = false;
                    string? id = RequestId(json);
                    if (tooLong) { await Reply(JsonSerializer.Serialize(new { ok = false, error = $"Request exceeds {RequestMaxBytes - 1} bytes." }), id).ConfigureAwait(false); continue; }
                    long now = Environment.TickCount64, ticked = Interlocked.Read(ref lastTickAt);
                    if (ticked != 0 && now - ticked > StallMs)
                    {
                        await Reply(JsonSerializer.Serialize(new { ok = false, code = "stalled",
                            error = $"Game thread has not ticked for {now - ticked} ms; the client is stalled." }), id).ConfigureAwait(false);
                        continue;
                    }
                    var completion = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
                    requests.Enqueue(new(json, now, closed.Token, completion));
                    _ = AnswerAsync(completion.Task, id, Reply, closed.Token);
                }
            }
        }
        catch (OperationCanceledException) { }
        catch (IOException) { }
        catch (SocketException) { }
        catch (ObjectDisposedException) { }
        finally { closed.Cancel(); }
    }

    private static async Task AnswerAsync(Task<object> answer, string? id, System.Func<string, string?, Task> reply, CancellationToken closed)
    {
        try
        {
            object response = await answer.WaitAsync(closed).ConfigureAwait(false);
            await reply(JsonSerializer.Serialize(response), id).ConfigureAwait(false);
        }
        catch (OperationCanceledException) { }
        catch (IOException) { }
        catch (SocketException) { }
        catch (ObjectDisposedException) { }
    }

    private static bool TouchesInputs(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Object || !document.RootElement.TryGetProperty("action", out var action) ||
                action.ValueKind != JsonValueKind.String) return false;
            string name = action.GetString()!;
            return Mutations.Contains(name) || name.StartsWith("control_");
        }
        catch (JsonException) { return false; }
    }

    // The raw JSON text of a request's requestId, if it carries one; anything else is answered without.
    private static string? RequestId(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Object || !document.RootElement.TryGetProperty("requestId", out var id)) return null;
            return id.ValueKind is JsonValueKind.String or JsonValueKind.Number ? id.GetRawText() : null;
        }
        catch (JsonException) { return null; }
    }

    // What the mod costs the game, as a player-facing client would feel it: the work of one tick and
    // the longest silence between ticks, worst of the last second; observe reports it.
    private readonly System.Diagnostics.Stopwatch tickWatch = new();
    private long lastTickStartedAt, perfWindowAt;
    private double tickMs, tickMaxMs, frameGapMaxMs;
    private double reportedTickMaxMs, reportedFrameGapMs;
    private object Performance() => new { tickMs = Math.Round(tickMs, 2), tickMaxMs = Math.Round(reportedTickMaxMs, 2),
        frameGapMs = Math.Round(reportedFrameGapMs), frameMs = Math.Round(lastTickDt * 1000, 1) };

    private void OnTick(float dt)
    {
        long started = Environment.TickCount64;
        if (lastTickStartedAt != 0) frameGapMaxMs = Math.Max(frameGapMaxMs, started - lastTickStartedAt);
        lastTickStartedAt = started;
        tickWatch.Restart();
        try { Tick(dt); }
        finally
        {
            tickMs = tickWatch.Elapsed.TotalMilliseconds;
            tickMaxMs = Math.Max(tickMaxMs, tickMs);
            if (started - perfWindowAt >= 1000)
            {
                reportedTickMaxMs = tickMaxMs; reportedFrameGapMs = frameGapMaxMs;
                tickMaxMs = frameGapMaxMs = 0; perfWindowAt = started;
            }
        }
    }

    private void Tick(float dt)
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
                // Both senses stream only while a controller is reading them.
                if (now - lastSenseAt < 5000) { terrainSensor.Sample(now, sensorPriority); vision.Sample(now); }
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
        // A player keeps digging through a short drop (the block under the feet gives way) or with wet
        // feet; only losing the world, a menu, or the hand on the keyboard ends a block action.
        blockActions.Tick(CanControl() && !ManualInput());
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
            if (Environment.TickCount64 >= stopAt || !CanControl()) { step?.Expire(); StopMovement(); }
            else if (step != null) ApplyStep(Environment.TickCount64);
            else SetMovement(true);
        }

    }

    // Judge control hold refreshes when the bridge received them, before expiring the
    // owner on a delayed render tick. Requests cancelled by the network timeout
    // are still discarded and cannot revive control.
    private void DrainRequests()
    {
        Interlocked.Exchange(ref lastTickAt, Environment.TickCount64);
        while (requests.TryDequeue(out var pending))
        {
            if (pending.Cancellation.IsCancellationRequested) continue;
            long waited = Environment.TickCount64 - pending.ReceivedAt;
            if (waited > RequestDeadlineMs)
            {
                // The hand never reached the keys: the request is refused rather than acted on late.
                pending.Completion.TrySetResult(new { ok = false, code = "expired", error = $"Request waited {waited} ms for a game tick; nothing was done." });
                continue;
            }
            try { pending.Completion.TrySetResult(Execute(pending.Json, pending.ReceivedAt)); }
            catch (JsonException) { pending.Completion.TrySetResult(new { ok = false, error = "Invalid JSON request." }); }
            catch (Exception exception)
            {
                // Only an act that may have touched the inputs lets go of them; a failed read never does.
                if (TouchesInputs(pending.Json)) { ReleaseControl("action_error"); StopMovement(); StopHandAction(); }
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
            case "inspect_target": return CanControl() ? context.InspectTarget(life.Session) : new { ok = false, error = "Close menus and unpause before inspecting." };
            case "environment": return context.Environment(life.Session);
            case "events": return Events(request);
            case "messages": return Messages(request);
            case "can_see": return CanSee(request);
            case "respawn": return Respawn(request);
            case "ui_dialogs": return dialogs.Observe();
            case "ui_activate": return dialogs.Activate(request);
            case "ui_close": return dialogs.Close(request);
            case "inventory": return inventory.Observe();
            case "recipes": return Recipes(request);
            case "item_info": return ItemInfo(request);
            case "catalog": return handbook.CatalogPage(request);
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
            case "map_waypoint_add": return MapWaypointAdd(request);
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
    private static readonly HashSet<string> Mutations = ["move_to", "move", "look", "aim_cell", "select", "interact", "attack", "stop", "respawn", "craft", "inventory_move", "drop", "open_container", "container_move", "close_container", "look_at", "block_action_begin", "block_action_continue", "select_recipe", "ui_activate", "ui_close"];
    private bool CanControl() => api.World?.Player?.Entity?.Alive == true && !api.IsGamePaused &&
        !api.Gui.OpenedGuis.Any(dialog => dialog.IsOpened() && DialogAdapter.BlocksControl(dialog));

    // Releases every owned input; runs on world exit and mod disposal.
    private void StopBridge()
    {
        ReleaseControl("bridge_off");
        terrainSensor?.Reset();
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
