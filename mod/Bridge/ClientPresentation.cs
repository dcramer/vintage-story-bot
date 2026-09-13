using System.Globalization;
using System.Reflection;
using Vintagestory.API.Client;
using Vintagestory.Client.NoObf;

namespace VintageStoryAI;

// Operator launch settings for rendering only. Never reapplied during play or used by gameplay policy.
internal static class ClientPresentation
{
    // SetMode is the native renderer setter; zoom's target is private in the installed client.
    private static readonly MethodInfo? SetMode = typeof(PlayerCamera).GetMethod("SetMode", BindingFlags.Instance | BindingFlags.NonPublic);
    private static readonly FieldInfo? Distance = typeof(PlayerCamera).GetField("targetCameraDistance", BindingFlags.Instance | BindingFlags.NonPublic);

    public static void Apply(ICoreClientAPI api)
    {
        var mode = Environment.GetEnvironmentVariable("VINTAGE_STORY_CAMERA");
        if (string.IsNullOrEmpty(mode)) return;
        var desired = mode switch
        {
            "firstperson" => EnumCameraMode.FirstPerson,
            "thirdperson" => EnumCameraMode.ThirdPerson,
            "overhead" => EnumCameraMode.Overhead,
            _ => (EnumCameraMode?)null
        };
        if (desired == null || !float.TryParse(Environment.GetEnvironmentVariable("VINTAGE_STORY_CAMERA_DISTANCE"),
            NumberStyles.Float, CultureInfo.InvariantCulture, out var distance) || !float.IsFinite(distance) || distance < 1 || distance > 10)
        {
            api.Logger.Error("[AI bridge] Invalid camera presentation settings.");
            return;
        }
        if (api.World is not ClientMain game || SetMode == null || Distance == null)
        {
            api.Logger.Error("[AI bridge] Camera presentation is unsupported by this client.");
            return;
        }
        SetMode.Invoke(game.MainCamera, [desired.Value]);
        Distance.SetValue(game.MainCamera, distance);
        game.MainCamera.Tppcameradistance = distance;
    }

    public static object Observe(ICoreClientAPI api) => new
    {
        width = api.Render.FrameWidth, height = api.Render.FrameHeight,
        camera = api.Render.CameraType.ToString(), actualCamera = api.World.Player.CameraMode.ToString(),
        distance = (api.World as ClientMain)?.MainCamera.Tppcameradistance,
        fov = ClientSettings.FieldOfView, uiScale = ClientSettings.GUIScale
    };
}
