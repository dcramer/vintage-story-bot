using System.Text.Json;
using Vintagestory.API.Client;
using Vintagestory.API.Common;
using Vintagestory.API.MathTools;
using Vintagestory.Client.NoObf;

namespace VintageStoryAI;

// One native operation; only its selected cell/adjacent empty destination is observed.
internal sealed class BlockActions(ICoreClientAPI api)
{
    private string? id, kind, target, item, before, after, changedCode, reason;
    private string state = "idle";
    private BlockPos? position;
    private Vec3d? hit, origin;
    private int slot, quantity;
    private long expires, sequence, changedAt, observedAt;
    public bool Digging => state == "working" && kind == "dig";
    public bool StarvingRecovery { get; private set; }

    public void Reset() { Cancel("world_changed"); id = null; position = null; StarvingRecovery = false; }

    public void Cancel(string why)
    {
        if (Digging) api.Input.InWorldMouseButton.Left = false;
        if (state is "working" or "changed") { state = "cancelled"; reason = why; }
    }

    public object Begin(JsonElement request, InventoryAdapter inventory, bool starvingRecovery = false)
    {
        var player = api.World.Player;
        if (player.WorldData.CurrentGameMode is not (EnumGameMode.Survival or EnumGameMode.Creative))
            return Error("Block actions require survival or creative mode.");
        var selection = player.CurrentBlockSelection;
        var stack = player.InventoryManager.ActiveHotbarSlot.Itemstack;
        string? String(string key) => request.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        string? nextId = String("id"), nextKind = String("kind");
        if (!Guid.TryParseExact(nextId, "N", out _) || nextId == id || nextKind is not ("dig" or "place"))
            return Error("Invalid or reused block operation id/kind.");
        if (selection?.Face == null || selection.Position.dimension != 0 ||
            api.World.BlockAccessor.GetChunkAtBlockPos(selection.Position) == null)
            return Error("Aim at a loaded block in the main dimension.");
        var block = api.World.BlockAccessor.GetBlock(selection.Position);
        if (String("target") != SceneSensor.BlockKey(selection.Position, block) ||
            !inventory.Matches(String("expectedState")) ||
            !request.TryGetProperty("slot", out var slotField) || !slotField.TryGetInt32(out int selectedSlot) ||
            selectedSlot is < 0 or > 9 || selectedSlot != player.InventoryManager.ActiveHotbarSlotNumber ||
            !request.TryGetProperty("item", out var itemField) || itemField.ValueKind is not (JsonValueKind.String or JsonValueKind.Null) ||
            itemField.GetString() != stack?.Collectible.Code.ToString())
            return Error("Target or inventory changed; inspect before acting.");
        var destination = selection.Position.Copy();
        if (nextKind == "place")
        {
            if (stack?.Class != EnumItemClass.Block) return Error("Selected item is not a block stack.");
            if (String("face") != selection.Face.Code) return Error("Selected face changed.");
            if (block.IsReplacableBy(stack.Block)) return Error("Use a non-replaceable support block.");
            destination.Add(selection.Face);
            var blocks = api.World.BlockAccessor;
            if (blocks.GetChunkAtBlockPos(destination) == null || blocks.GetBlock(destination).Id != 0 ||
                blocks.GetBlock(destination, BlockLayersAccess.Fluid).Id != 0)
                return Error("Placement destination must be loaded, empty and dry.");
        }
        else
        {
            var entity = player.Entity;
            var p = entity.Pos;
            var body = entity.CollisionBox;
            // No digging the player's support or a block intersecting their body.
            if (destination.X + 1 > p.X + body.X1 && destination.X < p.X + body.X2 &&
                destination.Z + 1 > p.Z + body.Z1 && destination.Z < p.Z + body.Z2 &&
                destination.Y + 1 >= p.Y - .05 && destination.Y < p.Y + body.Y2)
                return Error("Refusing to dig the player's footing/body cell.");
            if (block.GetRequiredMiningTier(api.World, destination) > (stack?.Collectible.ToolTier ?? 0))
                return Error("Selected tool mining tier is insufficient.");
        }
        Cancel("replaced");
        StarvingRecovery = starvingRecovery;
        id = nextId; kind = nextKind; target = String("target"); slot = selectedSlot;
        item = stack?.Collectible.Code.ToString(); quantity = stack?.StackSize ?? 0;
        position = destination; origin = player.Entity.Pos.XYZ.Clone();
        hit = selection.Position.ToVec3d().Add(selection.HitPosition);
        before = api.World.BlockAccessor.GetBlock(position).Code.ToString(); after = before;
        state = "working"; reason = null; changedCode = null; sequence = 0; changedAt = 0;
        expires = System.Environment.TickCount64 + 2000;
        observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (kind == "dig") api.Input.InWorldMouseButton.Left = true;
        else if (api.World is ClientMain game)
        {
            // Same single-placement path as OnBlockBuild; native behavior, claims, collision and packets.
            var placement = selection.Clone();
            placement.Position = destination.Copy(); placement.DidOffset = true;
            string failure = "";
            if (!game.OnPlayerTryPlace(placement, ref failure)) { state = "failed"; reason = failure ?? "placement_refused"; }
            else game.HandSetAttackBuild = true;
        }
        else { state = "failed"; reason = "native_client_unavailable"; }
        Sample();
        return Observe();
    }

    public object Read(JsonElement request, bool renew)
    {
        if (!request.TryGetProperty("id", out var value) || value.ValueKind != JsonValueKind.String || value.GetString() != id)
            return Error("Unknown block operation; session or operation changed.");
        if (renew)
        {
            if (!request.TryGetProperty("sequence", out var next) || !next.TryGetInt64(out long number) || number <= sequence)
                return Error("Block operation sequence must increase.");
            sequence = number;
            // Expiry is terminal, never restart a released hold.
            if (Digging && System.Environment.TickCount64 < expires) expires = System.Environment.TickCount64 + 2000;
        }
        Sample();
        return Observe();
    }

    public void Tick(bool ready)
    {
        if (state is not ("working" or "changed")) return;
        if (!ready) { Cancel("controls_or_life_changed"); return; }
        Sample();
        if (!Digging) return;
        var player = api.World.Player;
        var selection = player.CurrentBlockSelection;
        if (System.Environment.TickCount64 >= expires) Cancel("expired");
        else if (selection == null || target != SceneSensor.BlockKey(selection.Position, api.World.BlockAccessor.GetBlock(selection.Position)))
            Cancel("target_changed");
        else if (player.InventoryManager.ActiveHotbarSlotNumber != slot ||
            player.InventoryManager.ActiveHotbarSlot.Itemstack?.Collectible.Code.ToString() != item)
            Cancel("held_item_changed");
        else api.Input.InWorldMouseButton.Left = true;
    }

    public void Changed(BlockPos pos, Block? oldBlock)
    {
        if (position?.Equals(pos) == true) Sample();
    }

    private void Sample()
    {
        if (position == null || state is not ("working" or "changed")) return;
        // Stop observing once the short verification window ends. Never become a remote block query.
        if (changedAt != 0 && System.Environment.TickCount64 - changedAt > 5000) { Cancel("verification_expired"); return; }
        var entity = api.World.Player.Entity;
        if (origin == null || entity.Pos.XYZ.DistanceTo(origin) > .35 || entity.Pos.Dimension != position.dimension || !Visible())
        { Cancel("observation_lost"); return; }
        after = api.World.BlockAccessor.GetBlock(position).Code.ToString();
        observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (changedCode != null && after != changedCode)
        { state = "failed"; reason = "block_changed_during_verification"; return; }
        if (after == before)
        {
            if (state == "changed") { state = "failed"; reason = "block_change_reverted"; }
            return;
        }
        if (Digging) api.Input.InWorldMouseButton.Left = false;
        state = "changed";
        changedCode = after;
        if (changedAt == 0) changedAt = System.Environment.TickCount64;
    }

    private bool Visible()
    {
        var eye = api.World.Player.Entity.Pos.XYZ.Add(api.World.Player.Entity.LocalEyePos);
        if (hit == null || position == null || eye.DistanceTo(hit) > api.World.Player.WorldData.PickingRange + .1) return false;
        var blocks = api.World.BlockAccessor;
        int steps = (int)Math.Ceiling(eye.DistanceTo(hit) * 4);
        for (int i = 0; i <= steps; i++)
        {
            double t = steps == 0 ? 0 : (double)i / steps;
            if (blocks.GetChunkAtBlockPos(new BlockPos((int)Math.Floor(eye.X + (hit.X - eye.X) * t),
                (int)Math.Floor(eye.Y + (hit.Y - eye.Y) * t), (int)Math.Floor(eye.Z + (hit.Z - eye.Z) * t), 0)) == null) return false;
        }
        if (blocks.GetChunkAtBlockPos(position) == null) return false;
        BlockSelection? selected = null;
        EntitySelection? selectedEntity = null;
        api.World.RayTraceForSelection(eye, hit, ref selected, ref selectedEntity);
        return selectedEntity == null && (selected == null || selected.Position.Equals(position) ||
            SceneSensor.BlockKey(selected.Position, blocks.GetBlock(selected.Position)) == target);
    }

    public object Observe() => new { ok = true, id, kind, state, reason, target,
        position = position == null ? null : new { x = position.X, y = position.Y, z = position.Z, dimension = position.dimension },
        before, after, item, slot, quantity, observedAt,
        changedForMs = changedAt == 0 ? 0 : System.Environment.TickCount64 - changedAt,
        remainingMs = Digging ? Math.Max(0, expires - System.Environment.TickCount64) : 0 };

    private static object Error(string message) => new { ok = false, error = message };
}
