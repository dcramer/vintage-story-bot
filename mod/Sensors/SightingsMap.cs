namespace VintageStoryAI;

// The eye's short-term buffer of entities, ground items and blocks it has
// seen, or living entities it could plausibly hear. Not memory: a snapshot
// returns what was confirmed since the reader last looked, and Node
// remembers what left the view.
public sealed class SightingsMap(long ttlMs = 60000)
{
    public sealed record Sighting(string Kind, string Code, Point3 Point, string How, object? Extra, long At);
    private readonly Dictionary<string, Sighting> sightings = new();
    public void Clear() => sightings.Clear();
    // Entities are confirmed every tick; a block only when its column or cell
    // is resampled, which a slow sweep can take several seconds to reach.
    public static long Window(string kind) => kind == "block" ? 8_000 : 1_000;

    public void Put(string key, string kind, string code, Point3 point, string how, object? extra, long now) =>
        sightings[key] = new(kind, code, point, how, extra, now);
    public void Prune(long now)
    {
        foreach (var (key, value) in sightings.ToArray()) if (now - value.At > ttlMs) sightings.Remove(key);
    }
    public IEnumerable<KeyValuePair<string, Sighting>> Current(long now, string? kind = null) =>
        sightings.Where(pair => (kind == null || pair.Value.Kind == kind) && now - pair.Value.At <= Window(pair.Value.Kind));
    // Confirmed since `after` on this clock, inclusive (the tick that answered
    // the last read may have confirmed more in the same millisecond); a reader
    // ahead of the clock (a restarted client) is given everything current again.
    public object[] Snapshot(long now, long after = 0) => Current(now)
        .Where(p => after > now || p.Value.At >= after)
        .Select(p => new object?[] { p.Key, p.Value.Kind, p.Value.Code, Math.Round(p.Value.Point.X, 3), Math.Round(p.Value.Point.Y, 3),
            Math.Round(p.Value.Point.Z, 3), p.Value.How, p.Value.At, p.Value.Extra }).ToArray();
}
