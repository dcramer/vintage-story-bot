using Vintagestory.API.Client;
using Vintagestory.GameContent;

namespace VintageStoryAI;

// The player's own markers on the world map: exactly what the map screen lists, including the
// "You died here" gravestone the server adds on death. Nothing about other players or the terrain.
internal sealed class MapWaypointSensor(ICoreClientAPI api)
{
    private WaypointMapLayer? Layer =>
        api.ModLoader.GetModSystem<WorldMapManager>()?.MapLayers?.OfType<WaypointMapLayer>().FirstOrDefault();

    public object Observe()
    {
        var layer = Layer;
        if (layer == null) return new { ok = false, error = "World map unavailable on this world." };
        var waypoints = layer.ownWaypoints ?? [];
        return new
        {
            ok = true,
            observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            count = waypoints.Count,
            // index is what the game's own remove command takes; it shifts whenever the list changes.
            waypoints = waypoints.Select((waypoint, index) => new
            {
                index,
                guid = Id(waypoint),
                title = waypoint.Title,
                icon = waypoint.Icon,
                color = waypoint.Color,
                pinned = waypoint.Pinned,
                temporary = waypoint.Temporary,
                position = new { x = waypoint.Position.X, y = waypoint.Position.Y, z = waypoint.Position.Z }
            }).ToArray()
        };
    }

    // Markers the server adds (death) may carry no Guid; identify those by what the map shows for them.
    private static string Id(Waypoint waypoint) => waypoint.Guid ??
        $"{waypoint.Icon}:{Math.Round(waypoint.Position.X)}:{Math.Round(waypoint.Position.Y)}:{Math.Round(waypoint.Position.Z)}";

    public int? IndexOf(string guid)
    {
        var waypoints = Layer?.ownWaypoints;
        if (waypoints == null) return null;
        int index = waypoints.FindIndex(waypoint => Id(waypoint) == guid);
        return index < 0 ? null : index;
    }
}
