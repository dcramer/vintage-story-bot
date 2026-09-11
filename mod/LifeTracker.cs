namespace VintageStoryAI;

public sealed record LifeEvent(long id, long at, string type, object data);
public sealed record EventBatch(bool ok, string session, long cursor, long latest, bool missed, LifeEvent[] events);

public sealed class LifeTracker
{
    private readonly Queue<LifeEvent> events = new();
    private long sequence;
    private bool initialized;
    private bool alive;
    private float? health;
    private float? maximumHealth;
    private readonly Dictionary<string, bool> alerts = new();
    public string Session { get; } = Guid.NewGuid().ToString("N");
    public string? DeathId { get; private set; }
    public long DeadSince { get; private set; }
    public long? RespawnRequestedAt { get; private set; }
    public long? LastDamageAt { get; private set; }
    public long? LastAttritionAt { get; private set; }
    public string[] Alerts => alerts.Where(pair => pair.Value).Select(pair => pair.Key).ToArray();

    public bool Sample(bool nextAlive, float? nextHealth, Point3 position, long now,
        float? maxHealth = null, float? food = null, float? maxFood = null, float? oxygen = null, float? maxOxygen = null,
        float? stability = null)
    {
        // EntityBehaviorHealth.UpdateMaxHealth moves a full health bar with its nutrition cap.
        // Exclude only that exact full→full adjustment; even tiny losses below the cap interrupt.
        bool capAdjustment = maximumHealth.HasValue && maxHealth.HasValue && maxHealth < maximumHealth &&
            health == maximumHealth && nextHealth == maxHealth;
        bool lost = initialized && alive && health.HasValue && nextHealth.HasValue && nextHealth < health && !capAdjustment;
        // Rust-world attrition: tiny periodic losses while temporal stability is near zero. Not an attack; navigation may continue.
        bool attrition = lost && stability.HasValue && float.IsFinite(stability.Value) && stability < 0.15f && health!.Value - nextHealth!.Value <= 0.5f;
        bool hurt = lost && !attrition;
        if (lost)
        {
            if (hurt) LastDamageAt = now; else LastAttritionAt = now;
            Add(now, "health_lost", new { amount = health!.Value - nextHealth!.Value, health = nextHealth, cause = attrition ? "instability" : null });
        }
        if (!nextAlive && (!initialized || alive))
        {
            DeadSince = now;
            DeathId = $"{Session}:{sequence + 1}";
            RespawnRequestedAt = null;
            Add(now, "died", new { deathId = DeathId, position = new { x = position.X, y = position.Y, z = position.Z } });
        }
        else if (nextAlive && initialized && !alive)
        {
            Add(now, "alive", new { deathId = DeathId, position = new { x = position.X, y = position.Y, z = position.Z } });
            DeathId = null;
            RespawnRequestedAt = null;
        }
        initialized = true;
        alive = nextAlive;
        health = nextHealth;
        maximumHealth = maxHealth;
        bool low = false;
        if (nextAlive)
        {
            low |= Threshold("low_health", nextHealth, maxHealth, 0.30f, now);
            low |= Threshold("low_food", food, maxFood, 0.20f, now);
            low |= Threshold("low_oxygen", oxygen, maxOxygen, 0.20f, now);
        }
        else alerts.Clear();
        return hurt || !nextAlive || low;
    }

    private bool Threshold(string name, float? current, float? maximum, float threshold, long now)
    {
        if (!current.HasValue || !maximum.HasValue || !float.IsFinite(current.Value) ||
            !float.IsFinite(maximum.Value) || maximum <= 0) return false;
        bool wasLow = alerts.GetValueOrDefault(name);
        float ratio = current.Value / maximum.Value;
        bool isLow = wasLow ? ratio <= threshold + 0.05f : ratio <= threshold;
        alerts[name] = isLow;
        if (isLow != wasLow) Add(now, isLow ? name : name + "_cleared", new { current, max = maximum });
        return isLow && !wasLow;
    }

    public bool RequestRespawn(string deathId, long now)
    {
        if (alive || DeathId == null || deathId != DeathId || RespawnRequestedAt != null) return false;
        RespawnRequestedAt = now;
        Add(now, "respawn_requested", new { deathId });
        return true;
    }

    public EventBatch Read(long after, string? session)
    {
        bool reset = session != null && session != Session;
        if (reset) after = 0;
        bool missed = reset || after > sequence || (events.Count > 0 && after < events.Peek().id - 1);
        if (after > sequence) after = 0;
        var batch = events.Where(e => e.id > after).Take(64).ToArray();
        return new(true, Session, batch.Length == 0 ? Math.Min(after, sequence) : batch[^1].id, sequence, missed, batch);
    }

    private void Add(long now, string type, object data)
    {
        events.Enqueue(new(++sequence, now, type, data));
        while (events.Count > 128) events.Dequeue();
    }
}
