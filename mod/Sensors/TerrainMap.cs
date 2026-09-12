namespace VintageStoryAI;

public readonly record struct Cell(int X, int Y, int Z);
public readonly record struct Bounds(double X1, double Y1, double Z1, double X2, double Y2, double Z2);

public sealed class TerrainMap(int capacity = 16384, long ttlMs = 120000, int radius = 64)
{
    private const long RefreshDeltaMs = 10_000;
    // A null Boxes row is either a real change (the block was replaced) or
    // the eye merely forgetting a cell it no longer keeps; Node's map keeps
    // forgotten geometry and drops only changed cells.
    private sealed record Observation(Bounds[]? Boxes, string? Traits, string? Code, long At, long Sequence, long PublishedAt, string? Reason = null);
    private readonly Dictionary<Cell, Observation> cells = new();
    // Every publication in sequence order, appended only: a page is a slice of it and the oldest
    // live cell is at its head. An entry whose cell has since been published again or evicted is
    // dead and skipped; the log is compacted when dead entries outnumber live ones.
    private readonly List<(long Sequence, Cell Cell)> log = new();
    private int head, dead;
    private long sequence, lostThrough;
    public string Session { get; private set; } = Guid.NewGuid().ToString("N");
    public void Clear() { cells.Clear(); log.Clear(); head = dead = 0; sequence = lostThrough = 0; Session = Guid.NewGuid().ToString("N"); }
    public bool Fresh(Cell cell, long now, long age = 500) =>
        cells.TryGetValue(cell, out var value) && value.Boxes != null && now - value.At <= Math.Min(age, ttlMs);
    private bool Live(int index) => cells.TryGetValue(log[index].Cell, out var value) && value.Sequence == log[index].Sequence;
    private void Set(Cell cell, Observation? prior, Observation next)
    {
        cells[cell] = next;
        if (prior != null && prior.Sequence == next.Sequence) return;
        if (prior != null) dead++;
        log.Add((next.Sequence, cell));
        if (head + dead > log.Count / 2 && log.Count > 64) Compact();
    }
    private void Compact()
    {
        int kept = 0;
        for (int i = head; i < log.Count; i++) if (Live(i)) log[kept++] = log[i];
        log.RemoveRange(kept, log.Count - kept);
        head = dead = 0;
    }
    public void Invalidate(Cell cell, string reason = "changed")
    {
        // Forget only knowledge we held; unrelated world updates must not flood the delta stream.
        if (!cells.TryGetValue(cell, out var prior) || prior.Boxes == null) return;
        long now = Environment.TickCount64;
        Set(cell, prior, new(null, null, null, now, ++sequence, now, reason));
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
    // What the cell holds: its shape, the trait words, and the block's code (null for air).
    public void Put(Cell cell, Bounds[] boxes, string? traits, long now, string? code = null)
    {
        cells.TryGetValue(cell, out var prior);
        if (prior != null && prior.Boxes != null && prior.Traits == traits && prior.Code == code && prior.Boxes.AsSpan().SequenceEqual(boxes))
        {
            bool publish = now - prior.PublishedAt >= RefreshDeltaMs;
            Set(cell, prior, new(prior.Boxes, traits, code, now, publish ? ++sequence : prior.Sequence, publish ? now : prior.PublishedAt));
        }
        else Set(cell, prior, new(boxes, traits, code, now, ++sequence, now));
        Bound();
    }
    private void Bound()
    {
        while (cells.Count > capacity && head < log.Count)
        {
            if (!Live(head)) { head++; dead--; continue; }
            var (oldest, cell) = log[head++];
            lostThrough = Math.Max(lostThrough, oldest);
            cells.Remove(cell);
        }
    }
    public void Prune(Point3 center, long now, Func<Cell, bool>? loaded = null)
    {
        foreach (var (cell, value) in cells.ToArray())
            if (value.Boxes != null && (now - value.At > ttlMs || Math.Abs(cell.X - center.X) > radius ||
                Math.Abs(cell.Z - center.Z) > radius || loaded?.Invoke(cell) == false)) Invalidate(cell, "forgot");
    }
    // A walk adds a wall of about 300 cells per block moved; pages must drain faster than that at a few
    // steps per second, or the feed falls behind and the follower waits on it.
    public const int PageSize = 1024;
    // Whether a reader at this cursor has pages left: a new session, or publications past it.
    public bool HasMore(long after, string? session) => session != Session || after < sequence;
    public TerrainPage Read(long after, string? session, long now)
    {
        bool reset = session != Session || after < lostThrough || after > sequence;
        if (reset) after = 0;
        // First entry above the cursor, by binary search over the ordered log.
        int low = head, high = log.Count;
        while (low < high) { int mid = (low + high) / 2; if (log[mid].Sequence > after) high = mid; else low = mid + 1; }
        var batch = new List<(Cell Cell, Observation Value)>(Math.Min(PageSize, log.Count - low));
        for (int i = low; i < log.Count && batch.Count < PageSize; i++)
            if (cells.TryGetValue(log[i].Cell, out var value) && value.Sequence == log[i].Sequence) batch.Add((log[i].Cell, value));
        long cursor = batch.Count == 0 ? sequence : batch[^1].Value.Sequence;
        return new TerrainPage(Session, reset, cursor, cursor < sequence, now,
            batch.Select(p => p.Value.Boxes == null
                ? new object?[] { p.Cell.X, p.Cell.Y, p.Cell.Z, p.Value.At, p.Value.Traits, null, p.Value.Reason ?? "changed" }
                : new object?[] { p.Cell.X, p.Cell.Y, p.Cell.Z, p.Value.At, p.Value.Traits,
                    p.Value.Boxes.Select(b => new[] { b.X1 - p.Cell.X, b.Y1 - p.Cell.Y, b.Z1 - p.Cell.Z,
                        b.X2 - p.Cell.X, b.Y2 - p.Cell.Y, b.Z2 - p.Cell.Z }).ToArray(), p.Value.Code }).ToArray());
    }
}

// One page of the surroundings delta stream, as the wire carries it.
public sealed record TerrainPage(string session, bool reset, long cursor, bool more, long clock, object?[][] cells);
