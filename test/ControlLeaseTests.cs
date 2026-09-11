using VintageStoryAI;

static class ControlLeaseTests
{
    public static void Run()
    {
        void Check(bool value, string name) { if (!value) throw new Exception(name); }
        var lease = new ControlLease();
        Check(lease.Begin("a", 0, 100), "acquire");
        Check(!lease.Begin("b", 0, 101), "exclusive owner");
        Check(!lease.Frame("b", 1, 101, 101, 400), "foreign frame");
        Check(lease.Frame("a", 1, 101, 101, 400), "owned frame");
        Check(!lease.Frame("a", 1, 102, 102, 400), "duplicate frame");
        Check(!lease.Frame("a", 2, 501, 501, 400), "late frame cannot resurrect owner");
        Check(lease.Frame("a", 2, 500, 600, 400), "timely queued frame survives a delayed tick");
        Check(lease.Expire(1000) && !lease.Active, "tick releases expired owner");
        Check(!lease.Begin("b", 0, 1001), "stale acquisition epoch");
        Check(lease.Begin("b", lease.Epoch, 1001), "new explicit acquisition");
        lease.Revoke("manual_input");
        Check(!lease.Frame("b", 2, 1002, 1002, 400), "revoked frame cannot resume");
        var map = new TerrainMap();
        map.Put(new(1, 2, 3), [], false, 0);
        Check(map.Fresh(new(1, 2, 3), 1), "observed air");
        var before = map.Session;
        map.Invalidate(new(1, 2, 3));
        Check(!map.Fresh(new(1, 2, 3), 1), "invalidation");
        map.Clear();
        Check(map.Session != before, "world reset invalidates cursors");
        Console.WriteLine("13 control/terrain checks passed.");
    }
}
