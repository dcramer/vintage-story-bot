using System.Reflection;
using System.Text.Json;
using Vintagestory.API.Client;
using Vintagestory.API.Common;
using Vintagestory.Client.NoObf;

namespace VintageStoryAI;

// Deterministic native-dialog handling: list open dialogs with their elements and screen bounds, and click a
// button by sending the same GUI mouse events a real click produces, at the element's own center. No pixels, no OCR.
public sealed class DialogAdapter(ICoreClientAPI api)
{
    private static readonly FieldInfo Interactive = typeof(GuiComposer).GetField("interactiveElements", BindingFlags.Instance | BindingFlags.NonPublic)!;
    private static readonly FieldInfo Static = typeof(GuiComposer).GetField("staticElements", BindingFlags.Instance | BindingFlags.NonPublic)!;
    // Native buttons that destroy data or bypass the operator's own leave/stop path.
    private static readonly string[] Refused = ["deletebtn", "delete world"];

    private IEnumerable<GuiDialog> OpenDialogs() => api.Gui.OpenedGuis.Where(dialog => dialog.IsOpened());

    public object Observe() => new
    {
        ok = true,
        frame = new { width = api.Render.FrameWidth, height = api.Render.FrameHeight },
        dialogs = OpenDialogs().Select(dialog => new
        {
            name = dialog.DebugName,
            type = dialog.DialogType.ToString(),
            capturesInput = dialog.CaptureAllInputs(),
            elements = Elements(dialog).Select(entry => Describe(entry.Key, entry.Element)).ToArray(),
        }).ToArray(),
    };

    public object Activate(JsonElement request)
    {
        if (!request.TryGetProperty("dialog", out var dialogField) || dialogField.ValueKind != JsonValueKind.String ||
            !request.TryGetProperty("element", out var elementField) || elementField.ValueKind != JsonValueKind.String)
            return new { ok = false, error = "Expected dialog and element strings from ui_dialogs." };
        string dialogName = dialogField.GetString()!, elementName = elementField.GetString()!;
        var dialogs = OpenDialogs().Where(dialog => dialog.DebugName == dialogName).ToArray();
        if (dialogs.Length != 1) return new { ok = false, error = $"Expected one open dialog named {dialogName}; found {dialogs.Length}." };
        var matches = Elements(dialogs[0])
            .Where(entry => entry.Element is GuiElementTextButton || entry.Element is GuiElementToggleButton)
            .Where(entry => string.Equals(entry.Key, elementName, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(TextOf(entry.Element), elementName, StringComparison.OrdinalIgnoreCase))
            .ToArray();
        if (matches.Length != 1) return new { ok = false, error = $"Expected one button matching {elementName}; found {matches.Length}. Use ui_dialogs keys or texts." };
        var (key, element) = matches[0];
        string text = TextOf(element) ?? "";
        if (Refused.Contains(key.ToLowerInvariant()) || Refused.Contains(text.ToLowerInvariant()))
            return new { ok = false, error = "Refused: destructive native button." };
        if (element is GuiElementControl { Enabled: false } || element is GuiElementTextButton { Visible: false })
            return new { ok = false, error = "Button is disabled or hidden." };
        var bounds = element.Bounds;
        int x = (int)Math.Round(bounds.absX + bounds.OuterWidth / 2), y = (int)Math.Round(bounds.absY + bounds.OuterHeight / 2);
        if (x < 0 || y < 0 || x >= api.Render.FrameWidth || y >= api.Render.FrameHeight)
            return new { ok = false, error = "Button center is outside the window; enlarge the display." };
        if (api.World is not ClientMain client || client.clientSystems.OfType<GuiManager>().FirstOrDefault() is not GuiManager gui)
            return new { ok = false, error = "GUI manager unavailable." };
        // The GUI manager is the client system that turns window mouse events into dialog input.
        client.MouseCurrentX = x;
        client.MouseCurrentY = y;
        gui.OnMouseMove(new MouseEvent(x, y, 0, 0));
        var down = new MouseEvent(x, y, EnumMouseButton.Left, 0);
        gui.OnMouseDown(down);
        var up = new MouseEvent(x, y, EnumMouseButton.Left, 0);
        gui.OnMouseUp(up);
        return new { ok = true, dialog = dialogName, element = key, text, x, y, handled = down.Handled || up.Handled, stillOpen = dialogs[0].IsOpened() };
    }

    // A dialog may register one composer under several names; report each element once.
    private static IEnumerable<(string Key, GuiElement Element)> Elements(GuiDialog dialog)
    {
        var seen = new HashSet<GuiElement>(ReferenceEqualityComparer.Instance);
        foreach (var (name, composer) in dialog.Composers)
        {
            if (!dialog.IsOpened(name)) continue;
            foreach (var field in new[] { Interactive, Static })
            {
                if (field.GetValue(composer) is not Dictionary<string, GuiElement> elements) continue;
                foreach (var (key, element) in elements)
                    if (seen.Add(element)) yield return (key, element);
            }
        }
    }

    private static string? TextOf(GuiElement element) => element switch
    {
        GuiElementTextButton button => button.Text,
        GuiElementEditableTextBase input => input.GetText(),
        GuiElementDropDown dropDown => string.Join(",", dropDown.SelectedValues),
        GuiElementTextBase text => text.Text,
        _ => null,
    };

    private static object Describe(string key, GuiElement element)
    {
        var bounds = element.Bounds;
        return new
        {
            key,
            type = element switch
            {
                GuiElementTextButton => "button",
                GuiElementToggleButton => "toggle",
                GuiElementSwitch => "switch",
                GuiElementDropDown => "dropdown",
                GuiElementEditableTextBase => "input",
                GuiElementTextBase => "text",
                _ => element.GetType().Name,
            },
            text = TextOf(element),
            on = element switch { GuiElementToggleButton toggle => toggle.On, GuiElementSwitch toggle => toggle.On, _ => (bool?)null },
            enabled = element is not GuiElementControl control || control.Enabled,
            focus = element.HasFocus,
            bounds = new { x = (int)bounds.absX, y = (int)bounds.absY, width = (int)bounds.OuterWidth, height = (int)bounds.OuterHeight },
        };
    }
}
