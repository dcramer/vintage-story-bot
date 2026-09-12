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

// Hotbar, held-item and block interactions through the vanilla mouse-button and shift-key pipeline.
public sealed partial class AiBridgeMod
{
    private bool handSneak;
    private long handSneakArmedAt;
    // Ticks are 20ms; hold the interaction button this long after pressing shift so the ShiftKey control packet
    // reaches the server first (see SetHandButtons). A few ticks of margin because our tick trails SystemPlayerControl.
    private const long SneakArmMs = 60;
    private string? handAction;
    private string? handTarget;
    private int? handSlot;
    private string? handItem;
    private long handStopAt;
    private SystemMouseInWorldInteractions? worldInteractions;
    private bool? priorWorldInteraction;

    private object SelectHotbar(JsonElement request)
    {
        var entity = api.World!.Player.Entity;
        var hotbar = api.World!.Player.InventoryManager.GetHotbarInventory();
        if (!TryInteger(request, "slot", out int slot) || hotbar == null || slot < 0 || slot > 9 || slot >= hotbar.Count)
            return new { ok = false, error = "Select ordinary hotbar slots 0–9; extra/offhand slots are not selection indices." };
        if (!entity.Alive || api.IsGamePaused)
            return new { ok = false, error = "Cannot select while dead or paused." };
        StopHandAction();
        api.World.Player.InventoryManager.ActiveHotbarSlotNumber = slot;
        return new { ok = true, activeSlot = slot };
    }

    private object HandAction(string action, JsonElement request)
    {
        if (!TryInteger(request, "durationMs", out int handMilliseconds) || handMilliseconds < 1 || handMilliseconds > 2000)
            return new { ok = false, error = "durationMs must be an integer from 1 to 2000." };
        if (!CanControl())
            return new { ok = false, error = "Close menus and enter the world before interacting." };
        if (request.TryGetProperty("expectedTarget", out var expected) &&
            (expected.ValueKind is not (JsonValueKind.String or JsonValueKind.Null) || expected.GetString() != CurrentTargetKey()))
        {
            StopActs();
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
        if (action == "attack" && api.World!.Player.CurrentBlockSelection == null &&
            api.World!.Player.CurrentEntitySelection == null)
            return new { ok = false, error = "Aim at a block or entity before attacking." };
        bool sneakHand = false;
        if (request.TryGetProperty("sneak", out var handSneakField))
        {
            if (handSneakField.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                return new { ok = false, error = "sneak must be boolean." };
            sneakHand = handSneakField.GetBoolean();
        }
        StopActs();
        handSneak = sneakHand;
        handSneakArmedAt = sneakHand ? Environment.TickCount64 : 0;
        handAction = action;
        handTarget = CurrentTargetKey();
        handSlot = api.World!.Player.InventoryManager.ActiveHotbarSlotNumber;
        handItem = api.World.Player.InventoryManager.ActiveHotbarSlot.Itemstack?.Collectible.Code.ToString();
        // For sneak interactions the button press is delayed until shift has synced (SneakArmMs), so extend
        // the deadline to preserve the requested hold once the button actually goes down.
        handStopAt = Environment.TickCount64 + handMilliseconds + (sneakHand ? SneakArmMs : 0);
        SetHandButtons();
        return new { ok = true, status = "started", durationMs = handMilliseconds };
    }

    private object InventoryMove(string action, JsonElement request)
    {
        StopActs();
        return inventory.Move(request, action == "craft");
    }

    private object InventoryDrop(JsonElement request)
    {
        StopActs();
        return inventory.Drop(request);
    }

    private object OpenContainer(JsonElement request)
    {
        if (containers.Adopt() is { } adopted) return adopted;
        if (!CanControl())
            return new { ok = false, error = "Close menus and enter the world before opening." };
        if (!request.TryGetProperty("target", out var target) || target.ValueKind != JsonValueKind.String ||
            target.GetString() != CurrentTargetKey())
        {
            StopActs();
            return new { ok = false, error = "Aim at the container first; observe and aim again." };
        }
        StopActs();
        return containers.Open(request, worldInteractions, lastTickDt);
    }

    private object ContainerMove(JsonElement request)
    {
        StopActs();
        return containers.Move(request);
    }

    private object CloseContainer(JsonElement request)
    {
        StopActs();
        return containers.Close();
    }

    private object BlockActionBegin(JsonElement request)
    {
        var entity = api.World!.Player.Entity;
        bool blockRecovery = request.TryGetProperty("allowStarvingRecovery", out var blockRecoveryField) &&
            blockRecoveryField.ValueKind == JsonValueKind.True;
        if (request.TryGetProperty("allowStarvingRecovery", out blockRecoveryField) &&
            blockRecoveryField.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            return new { ok = false, error = "allowStarvingRecovery must be boolean." };
        if (!CanControl() || ManualInput() || !entity.OnGround || entity.FeetInLiquid || entity.MountedOn != null)
            return new { ok = false, error = "Block actions need grounded, dry, ready controls." };
        StopActs();
        return blockActions.Begin(request, inventory, blockRecovery);
    }

    private object Chat(JsonElement request)
    {
        if (!request.TryGetProperty("message", out var chatField) || chatField.ValueKind != JsonValueKind.String)
            return new { ok = false, error = "Supply a message string." };
        var chatText = chatField.GetString()!.Replace('\n', ' ').Replace('\r', ' ').Trim();
        // Never let generated status text be interpreted as a chat command.
        while (chatText.Length > 0 && (chatText[0] == '/' || chatText[0] == '.')) chatText = chatText[1..].TrimStart();
        if (chatText.Length == 0) return new { ok = false, error = "Empty chat message." };
        if (chatText.Length > 256) chatText = chatText[..256];
        string? to = null;
        if (request.TryGetProperty("to", out var toField))
        {
            if (toField.ValueKind != JsonValueKind.String || !System.Text.RegularExpressions.Regex.IsMatch(toField.GetString()!, "^[A-Za-z0-9_-]{1,64}$"))
                return new { ok = false, error = "to must be a player name." };
            to = toField.GetString();
        }
        // A private message is the game's own /pm; the text itself never starts a command.
        api.SendChatMessage(to == null ? chatText : $"/pm {to} {chatText}", GlobalConstants.GeneralChatGroup, null);
        return new { ok = true, status = "sent", message = chatText, to };
    }

    private object MapWaypointRemove(JsonElement request)
    {
        if (!request.TryGetProperty("guid", out var guidField) || guidField.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(guidField.GetString()))
            return new { ok = false, error = "Supply the waypoint guid from map_waypoints." };
        var guid = guidField.GetString()!;
        var index = mapWaypoints.IndexOf(guid);
        if (index == null) return new { ok = false, error = "No such waypoint on the map; read map_waypoints again." };
        // The map screen's own edit dialog deletes a marker by sending exactly this command; the server
        // validates it and resends the list, so verify by reading map_waypoints until the guid is gone.
        api.SendChatMessage($"/waypoint remove {index}", GlobalConstants.GeneralChatGroup, null);
        return new { ok = true, status = "requested", guid, index, verification = "map_waypoints" };
    }

    private object MapWaypointAdd(JsonElement request)
    {
        if (!request.TryGetProperty("title", out var titleField) || titleField.ValueKind != JsonValueKind.String)
            return new { ok = false, error = "Supply a title string." };
        var title = titleField.GetString()!.Replace('\n', ' ').Replace('\r', ' ').Trim();
        if (title.Length == 0 || title.Length > 64) return new { ok = false, error = "title must be 1–64 characters." };
        double[] at = new double[3];
        string[] names = ["x", "y", "z"];
        for (int i = 0; i < 3; i++)
            if (!request.TryGetProperty(names[i], out var field) || field.ValueKind != JsonValueKind.Number || !field.TryGetDouble(out at[i]) || !double.IsFinite(at[i]))
                return new { ok = false, error = "Supply finite x, y and z." };
        string icon = "circle", color = "#ff0000";
        bool pinned = false;
        if (request.TryGetProperty("icon", out var iconField))
        {
            if (iconField.ValueKind != JsonValueKind.String || !System.Text.RegularExpressions.Regex.IsMatch(iconField.GetString()!, "^[a-z0-9_-]{1,32}$"))
                return new { ok = false, error = "icon must be a short lowercase word." };
            icon = iconField.GetString()!;
        }
        if (request.TryGetProperty("color", out var colorField))
        {
            if (colorField.ValueKind != JsonValueKind.String || !System.Text.RegularExpressions.Regex.IsMatch(colorField.GetString()!, "^(#[0-9a-fA-F]{6}|[a-z]{1,24})$"))
                return new { ok = false, error = "color must be #rrggbb or a color name." };
            color = colorField.GetString()!;
        }
        if (request.TryGetProperty("pinned", out var pinnedField))
        {
            if (pinnedField.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return new { ok = false, error = "pinned must be boolean." };
            pinned = pinnedField.GetBoolean();
        }
        var culture = System.Globalization.CultureInfo.InvariantCulture;
        // The map screen's add dialog sends this command; = makes the coordinates absolute rather than
        // relative to the map's origin. The server validates it and resends the list: verify by reading
        // map_waypoints until a marker with this title appears.
        api.SendChatMessage(
            $"/waypoint addati {icon} ={at[0].ToString("0.##", culture)} ={at[1].ToString("0.##", culture)} ={at[2].ToString("0.##", culture)} {(pinned ? "true" : "false")} {color} {title}",
            GlobalConstants.GeneralChatGroup, null);
        return new { ok = true, status = "requested", title, icon, color, pinned, position = new { x = at[0], y = at[1], z = at[2] }, verification = "map_waypoints" };
    }

    private void SetHandButtons()
    {
        // We simulate a real player, so interactions must go through the game's own input pipeline: setting these
        // states makes SystemMouseInWorldInteractions run the normal item/block callbacks and, crucially, send the
        // same client->server packets a human's click sends. We never write blocks/inventory directly (that is
        // client-only prediction the server discards). The mod is only a cheaper substitute for driving the GUI.
        //
        // Shift-gated interactions (knapping/clay surface placement, ground storage) need the server to already know
        // ShiftKey is held. ShiftKey syncs on its own packet (MoveKeyChange, id 21) that SystemPlayerControl emits a
        // tick before our tick; the held-use "start" packet (id 25) is emitted the same tick we press the button. If
        // we pressed shift and the button together, the server would apply the interaction before it learned shift
        // was down and silently skip the shift branch. So arm shift first and hold the button until it has synced.
        bool sneakArmed = !handSneak || (handSneakArmedAt != 0 && Environment.TickCount64 - handSneakArmedAt >= SneakArmMs);
        if (handSneak) SetSneak(api.World.Player.Entity.Controls, true);
        api.Input.InWorldMouseButton.Left = handAction == "attack" && sneakArmed;
        api.Input.InWorldMouseButton.Right = handAction == "interact" && sneakArmed;
    }

    private int shiftKeyCode = -2;

    private void SetSneak(EntityControls controls, bool pressed)
    {
        // ShiftKey is the interaction modifier (ground placement, knapping, clay forming); Sneak is the motion state.
        controls.Sneak = pressed;
        controls.ShiftKey = pressed;
        // SystemPlayerControl overwrites these from the keyboard every tick and only syncs a control flag to the
        // server when it changes. Setting the controls directly is clobbered before it reaches the server, so drive
        // the shift key in the keyboard state; the game's own control sync then tells the server ShiftKey is held.
        if (shiftKeyCode == -2) shiftKeyCode = api.Input.GetHotKeyByCode("shift")?.CurrentMapping.KeyCode ?? -1;
        if (shiftKeyCode >= 0 && shiftKeyCode < api.Input.KeyboardKeyState.Length)
            api.Input.KeyboardKeyState[shiftKeyCode] = pressed;
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
}
