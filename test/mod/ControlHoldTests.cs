using VintageStoryAI;
using System.Text.Json;

static class ControlHoldTests
{
    public static void Run()
    {
        void Check(bool value, string name) { if (!value) throw new Exception(name); }
        var hold = new ControlHold();
        Check(hold.Begin("a", 0, 100), "acquire");
        Check(!hold.StarvingRecovery, "ordinary control hold safety");
        Check(!hold.Begin("b", 0, 101), "exclusive owner");
        Check(!hold.Frame("b", 1, 101, 101, 400), "foreign frame");
        Check(hold.Frame("a", 1, 101, 101, 400), "owned frame");
        Check(!hold.Frame("a", 1, 102, 102, 400), "duplicate frame");
        Check(!hold.Frame("a", 2, 5101, 5101, 400), "late frame cannot resurrect owner");
        Check(hold.Frame("a", 2, 2100, 2200, 180), "timely short frame survives a delayed replan");
        Check(hold.Expire(7200) && !hold.Active, "tick releases expired owner");
        Check(!hold.Begin("b", 0, 1001), "stale acquisition epoch");
        Check(hold.Begin("b", hold.Epoch, 1001, true) && hold.StarvingRecovery, "scoped starving recovery acquisition");
        hold.Release("manual_input");
        Check(!hold.StarvingRecovery, "release clears recovery scope");
        Check(!hold.Frame("b", 2, 1002, 1002, 400), "released frame cannot resume");
        var map = new TerrainMap();
        map.Put(new(1, 2, 3), [], null, 0);
        Check(map.Fresh(new(1, 2, 3), 1), "observed air");
        var first = JsonSerializer.SerializeToElement(map.Read(0, map.Session, 1));
        long cursor = first.GetProperty("cursor").GetInt64();
        map.Put(new(1, 2, 3), [], null, 100);
        var unchanged = JsonSerializer.SerializeToElement(map.Read(cursor, map.Session, 100));
        Check(unchanged.GetProperty("cells").GetArrayLength() == 0 && map.Fresh(new(1, 2, 3), 550),
            "unchanged terrain refreshes without flooding deltas");
        map.Put(new(1, 2, 3), [], null, 10_001);
        var refreshed = JsonSerializer.SerializeToElement(map.Read(cursor, map.Session, 10_001));
        Check(refreshed.GetProperty("cells").GetArrayLength() == 1, "stable terrain periodically republishes freshness");
        var before = map.Session;
        map.Put(new(4, 5, 6), [new(4, 5, 6, 5, 6, 7)], null, 10_001);
        map.Stale(new(4, 5, 6));
        Check(!map.Fresh(new(4, 5, 6), 10_001), "stale neighbor queued for resampling");
        var staleCursor = JsonSerializer.SerializeToElement(map.Read(0, map.Session, 10_001)).GetProperty("cursor").GetInt64();
        map.Put(new(4, 5, 6), [new(4, 5, 6, 5, 6, 7)], null, 10_002);
        Check(JsonSerializer.SerializeToElement(map.Read(staleCursor, map.Session, 10_002)).GetProperty("cells").GetArrayLength() == 0,
            "unchanged stale neighbor does not publish an unknown/geometry pair");
        map.Invalidate(new(1, 2, 3));
        Check(!map.Fresh(new(1, 2, 3), 1), "invalidation");
        map.Clear();
        Check(map.Session != before, "world reset invalidates cursors");
        // The publication log: pages are continuous slices, a republished cell appears once at its
        // newest sequence, and capacity evicts the cell published longest ago, never a live one twice.
        var small = new TerrainMap(capacity: 8);
        for (int i = 0; i < 8; i++) small.Put(new(i, 0, 0), [], null, 0);
        small.Put(new(0, 0, 0), [new(0, 0, 0, 1, 1, 1)], null, 1); // republished: cell 0 now newest
        small.Put(new(8, 0, 0), [], null, 1);                    // over capacity: cell 1 is the oldest live one
        Check(!small.Fresh(new(1, 0, 0), 1) && small.Fresh(new(0, 0, 0), 1), "capacity evicts the oldest publication, not a republished cell");
        var seen = new List<string>();
        long at = 0; bool more = true;
        while (more)
        {
            var page = JsonSerializer.SerializeToElement(small.Read(at, small.Session, 2));
            foreach (var row in page.GetProperty("cells").EnumerateArray()) seen.Add(row[0].GetInt32() + "," + row[1].GetInt32() + "," + row[2].GetInt32());
            at = page.GetProperty("cursor").GetInt64(); more = page.GetProperty("more").GetBoolean();
        }
        Check(seen.Count == 8 && seen.Distinct().Count() == 8 && seen[^1] == "8,0,0" && seen[^2] == "0,0,0", "pages cover every live cell once, in sequence order");
        for (int round = 0; round < 40; round++) for (int i = 0; i < 8; i++) small.Put(new(i + 100, 0, round), [], null, 2 + round);
        var tail = JsonSerializer.SerializeToElement(small.Read(0, small.Session, 50));
        Check(tail.GetProperty("cells").GetArrayLength() == 8, "a compacted log still pages every live cell");
        Console.WriteLine("20 control/terrain checks passed.");
    }
}
