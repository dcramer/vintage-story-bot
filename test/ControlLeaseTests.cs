using VintageStoryAI;
using System.Text.Json;

static class ControlLeaseTests
{
    public static void Run()
    {
        void Check(bool value, string name) { if (!value) throw new Exception(name); }
        var lease = new ControlLease();
        Check(lease.Begin("a", 0, 100), "acquire");
        Check(!lease.StarvingRecovery, "ordinary lease safety");
        Check(!lease.Begin("b", 0, 101), "exclusive owner");
        Check(!lease.Frame("b", 1, 101, 101, 400), "foreign frame");
        Check(lease.Frame("a", 1, 101, 101, 400), "owned frame");
        Check(!lease.Frame("a", 1, 102, 102, 400), "duplicate frame");
        Check(!lease.Frame("a", 2, 501, 501, 400), "late frame cannot resurrect owner");
        Check(lease.Frame("a", 2, 500, 600, 400), "timely queued frame survives a delayed tick");
        Check(lease.Expire(1000) && !lease.Active, "tick releases expired owner");
        Check(!lease.Begin("b", 0, 1001), "stale acquisition epoch");
        Check(lease.Begin("b", lease.Epoch, 1001, true) && lease.StarvingRecovery, "scoped starving recovery acquisition");
        lease.Revoke("manual_input");
        Check(!lease.StarvingRecovery, "revocation clears recovery scope");
        Check(!lease.Frame("b", 2, 1002, 1002, 400), "revoked frame cannot resume");
        var map = new TerrainMap();
        map.Put(new(1, 2, 3), [], false, 0);
        Check(map.Fresh(new(1, 2, 3), 1), "observed air");
        var first = JsonSerializer.SerializeToElement(map.Read(0, map.Session, 1));
        long cursor = first.GetProperty("cursor").GetInt64();
        map.Put(new(1, 2, 3), [], false, 100);
        var unchanged = JsonSerializer.SerializeToElement(map.Read(cursor, map.Session, 100));
        Check(unchanged.GetProperty("cells").GetArrayLength() == 0 && map.Fresh(new(1, 2, 3), 550),
            "unchanged terrain refreshes without flooding deltas");
        map.Put(new(1, 2, 3), [], false, 10_001);
        var refreshed = JsonSerializer.SerializeToElement(map.Read(cursor, map.Session, 10_001));
        Check(refreshed.GetProperty("cells").GetArrayLength() == 1, "stable terrain periodically republishes freshness");
        var before = map.Session;
        map.Put(new(4, 5, 6), [new(4, 5, 6, 5, 6, 7)], false, 10_001);
        map.Stale(new(4, 5, 6));
        Check(!map.Fresh(new(4, 5, 6), 10_001), "stale neighbor queued for resampling");
        var staleCursor = JsonSerializer.SerializeToElement(map.Read(0, map.Session, 10_001)).GetProperty("cursor").GetInt64();
        map.Put(new(4, 5, 6), [new(4, 5, 6, 5, 6, 7)], false, 10_002);
        Check(JsonSerializer.SerializeToElement(map.Read(staleCursor, map.Session, 10_002)).GetProperty("cells").GetArrayLength() == 0,
            "unchanged stale neighbor does not publish an unknown/geometry pair");
        map.Invalidate(new(1, 2, 3));
        Check(!map.Fresh(new(1, 2, 3), 1), "invalidation");
        map.Clear();
        Check(map.Session != before, "world reset invalidates cursors");
        Console.WriteLine("17 control/terrain checks passed.");
    }
}
