using VintageStoryAI;

static class LifeTests
{
    public static void Run()
    {
        int checks = 0;
        void Check(bool condition, string name)
        {
            if (!condition) throw new Exception(name);
            checks++;
        }
        var life = new LifeTracker();
        var p = new Point3(1, 2, 3);
        Check(!life.Sample(true, 15, p, 0, 15, 100, 100, 100, 100), "healthy baseline");
        Check(life.Read(0, null).events.Length == 0, "no baseline noise");
        Check(life.Sample(true, 14, p, 1, 15), "damage interrupts");
        Check(life.LastDamageAt == 1 && life.Read(0, null).events[0].type == "health_lost", "damage buffered");
        Check(life.Sample(true, 4, p, 2, 15, 20, 100, 10, 100), "low entry interrupts");
        Check(life.Alerts.Length == 3, "all low vitals");
        long cursor = life.Read(0, null).cursor;
        Check(!life.Sample(true, 4, p, 3, 15, 20, 100, 10, 100), "low state not perpetual stop");
        Check(life.Read(cursor, life.Session).events.Length == 0, "no low spam");
        life.Sample(true, 5, p, 4, 15, 23, 100, 23, 100);
        Check(life.Alerts.Length == 3, "hysteresis holds");
        life.Sample(true, 15, p, 5, 15, 100, 100, 100, 100);
        Check(life.Alerts.Length == 0 && life.Read(cursor, life.Session).events.All(e => e.type.EndsWith("_cleared")), "recovered");
        Check(!life.RequestRespawn("stale", 6), "cannot respawn alive");
        Check(life.Sample(false, 0, p, 7), "death interrupts");
        string death = life.DeathId!;
        Check(life.Read(0, null).events.Count(e => e.type == "died") == 1, "one death");
        life.Sample(false, 0, p, 8);
        Check(life.DeathId == death, "stable death id");
        Check(!life.RequestRespawn("wrong", 8) && life.RequestRespawn(death, 9), "death guard");
        Check(!life.RequestRespawn(death, 10), "no duplicate respawn");
        life.Sample(true, 15, p, 11);
        Check(life.DeathId == null && life.RespawnRequestedAt == null, "revival clears pending");
        Check(life.Read(0, null).events.Last().type == "alive", "revival event");
        life.Sample(false, 0, p, 12);
        Check(life.DeathId != death && !life.RequestRespawn(death, 13), "prior death cannot replay");
        Check(life.Read(9999, life.Session).missed && life.Read(0, "old world").missed, "invalid cursors resync");
        var initiallyDead = new LifeTracker();
        initiallyDead.Sample(false, 0, p, 1);
        Check(initiallyDead.DeathId != null, "joining dead captured");
        for (int i = 0; i < 200; i++)
        {
            life.Sample(true, 15, p, 100 + i * 2);
            life.Sample(true, 14, p, 101 + i * 2);
        }
        var batch = life.Read(0, life.Session);
        Check(batch.missed && batch.events.Length == 64, "bounded queue and page");
        var next = life.Read(batch.cursor, batch.session);
        Check(!next.missed && next.events.Length == 64 && next.cursor == next.latest, "cursor drains remainder");
        Check(life.Read(next.cursor, next.session).events.Length == 0, "read does not duplicate");
        var unknown = new LifeTracker();
        Check(!unknown.Sample(true, null, p, 0, 0, float.NaN, 100), "unknown vitals safe");
        Console.WriteLine($"{checks} lifecycle checks passed.");
    }
}
