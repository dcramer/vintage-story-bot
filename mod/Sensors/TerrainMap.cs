namespace VintageStoryAI;

public readonly record struct Cell(int X, int Y, int Z);
public readonly record struct Bounds(double X1, double Y1, double Z1, double X2, double Y2, double Z2);

public sealed class TerrainMap(int capacity = 16384, long ttlMs = 120000, int radius = 64)
{
    private const long RefreshDeltaMs = 10_000;
    private sealed record Observation(Bounds[]? Boxes, bool Hazard, long At, long Sequence, long PublishedAt);
    private readonly Dictionary<Cell, Observation> cells = new();
    private long sequence, lostThrough;
    public string Session { get; private set; } = Guid.NewGuid().ToString("N");
    public void Clear() { cells.Clear(); sequence = lostThrough = 0; Session = Guid.NewGuid().ToString("N"); }
    public bool Fresh(Cell cell, long now, long age = 500) =>
        cells.TryGetValue(cell, out var value) && value.Boxes != null && now - value.At <= Math.Min(age, ttlMs);
    public void Invalidate(Cell cell)
    {
        // Forget only knowledge we held; unrelated world updates must not flood the delta stream.
        if (!cells.TryGetValue(cell, out var prior) || prior.Boxes == null) return;
        long now = Environment.TickCount64;
        cells[cell] = new(null, false, now, ++sequence, now);
        Bound();
    }
    public void Stale(Cell cell)
    {
        // Neighbor-dependent shapes need prompt resampling after an adjacent
        // block update, but their last observed geometry is still safer than a
        // burst of synthetic "unknown" deltas. Put() publishes if it changed.
        if (cells.TryGetValue(cell, out var prior) && prior.Boxes != null)
            cells[cell] = prior with { At = 0 };
    }
    public void Put(Cell cell, Bounds[] boxes, bool hazard, long now)
    {
        if (cells.TryGetValue(cell, out var prior) && prior.Boxes != null && prior.Hazard == hazard &&
            prior.Boxes.AsSpan().SequenceEqual(boxes))
        {
            bool publish = now - prior.PublishedAt >= RefreshDeltaMs;
            cells[cell] = new(prior.Boxes, hazard, now, publish ? ++sequence : prior.Sequence,
                publish ? now : prior.PublishedAt);
        }
        else cells[cell] = new(boxes, hazard, now, ++sequence, now);
        Bound();
    }
    private void Bound()
    {
        if (cells.Count <= capacity) return;
        var oldest = cells.MinBy(pair => pair.Value.Sequence);
        lostThrough = Math.Max(lostThrough, oldest.Value.Sequence);
        cells.Remove(oldest.Key);
    }
    public void Prune(Point3 center, long now, Func<Cell, bool>? loaded = null)
    {
        foreach (var (cell, value) in cells.ToArray())
            if (value.Boxes != null && (now - value.At > ttlMs || Math.Abs(cell.X - center.X) > radius ||
                Math.Abs(cell.Z - center.Z) > radius || loaded?.Invoke(cell) == false)) Invalidate(cell);
    }
    public object Read(long after, string? session, long now)
    {
        bool reset = session != Session || after < lostThrough || after > sequence;
        if (reset) after = 0;
        var batch = cells.Where(p => p.Value.Sequence > after).OrderBy(p => p.Value.Sequence).Take(128).ToArray();
        long cursor = batch.Length == 0 ? sequence : batch[^1].Value.Sequence;
        return new { session = Session, reset, cursor, more = cursor < sequence, clock = now,
            cells = batch.Select(p => new object?[] { p.Key.X, p.Key.Y, p.Key.Z, p.Value.At, p.Value.Hazard,
                p.Value.Boxes?.Select(b => new[] { b.X1 - p.Key.X, b.Y1 - p.Key.Y, b.Z1 - p.Key.Z,
                    b.X2 - p.Key.X, b.Y2 - p.Key.Y, b.Z2 - p.Key.Z }).ToArray() }).ToArray() };
    }
}
