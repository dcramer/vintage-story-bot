namespace VintageStoryAI;

// Entities, ground items and watched blocks the camera has seen or the ears
// could plausibly hear, published as deltas like TerrainMap. A gone row
// forgets a sighting that has not been confirmed for its kind's lifetime.
public sealed class SightingsMap(int capacity = 4096)
{
    private const long RefreshDeltaMs = 5_000;
    public sealed record Sighting(string Kind, string Code, Point3 Point, string How, object? Extra, long At, long Sequence, long PublishedAt, bool Gone);
    private readonly Dictionary<string, Sighting> sightings = new();
    private long sequence, lostThrough;
    public string Session { get; private set; } = Guid.NewGuid().ToString("N");
    public void Clear() { sightings.Clear(); sequence = lostThrough = 0; Session = Guid.NewGuid().ToString("N"); }
    public static long Lifetime(string kind) => kind == "block" ? 120_000 : 20_000;

    public void Put(string key, string kind, string code, Point3 point, string how, object? extra, long now)
    {
        if (sightings.TryGetValue(key, out var prior) && !prior.Gone && prior.Code == code && prior.How == how &&
            SceneGeometry.Distance(prior.Point, point) < .25)
        {
            bool publish = now - prior.PublishedAt >= RefreshDeltaMs;
            sightings[key] = prior with { Point = point, Extra = extra, At = now,
                Sequence = publish ? ++sequence : prior.Sequence, PublishedAt = publish ? now : prior.PublishedAt };
        }
        else sightings[key] = new(kind, code, point, how, extra, now, ++sequence, now, false);
        Bound();
    }
    public void Forget(string key)
    {
        if (!sightings.TryGetValue(key, out var prior) || prior.Gone) return;
        long now = Environment.TickCount64;
        sightings[key] = prior with { At = now, Sequence = ++sequence, PublishedAt = now, Gone = true };
        Bound();
    }
    private void Bound()
    {
        if (sightings.Count <= capacity) return;
        var oldest = sightings.MinBy(pair => pair.Value.Sequence);
        lostThrough = Math.Max(lostThrough, oldest.Value.Sequence);
        sightings.Remove(oldest.Key);
    }
    public void Prune(long now)
    {
        foreach (var (key, value) in sightings.ToArray())
        {
            if (!value.Gone && now - value.At > Lifetime(value.Kind)) Forget(key);
            else if (value.Gone && now - value.At > 60_000) sightings.Remove(key);
        }
    }
    public IEnumerable<KeyValuePair<string, Sighting>> Current(string? kind = null) =>
        sightings.Where(pair => !pair.Value.Gone && (kind == null || pair.Value.Kind == kind));

    public object Read(long after, string? session, long now)
    {
        bool reset = session != Session || after < lostThrough || after > sequence;
        if (reset) after = 0;
        var batch = sightings.Where(p => p.Value.Sequence > after).OrderBy(p => p.Value.Sequence).Take(256).ToArray();
        long cursor = batch.Length == 0 ? sequence : batch[^1].Value.Sequence;
        return new { session = Session, reset, cursor, more = cursor < sequence, clock = now,
            sightings = batch.Select(p => p.Value.Gone
                ? new object?[] { p.Key, null }
                : new object?[] { p.Key, p.Value.Kind, p.Value.Code, Math.Round(p.Value.Point.X, 3), Math.Round(p.Value.Point.Y, 3),
                    Math.Round(p.Value.Point.Z, 3), p.Value.How, p.Value.At, p.Value.Extra }).ToArray() };
    }
}
