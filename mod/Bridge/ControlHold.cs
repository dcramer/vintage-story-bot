namespace VintageStoryAI;

public sealed class ControlHold
{
    private const int HeartbeatMs = 2000;
    public string? Owner { get; private set; }
    public long Epoch { get; private set; }
    public long Until { get; private set; }
    public long Sequence { get; private set; }
    public string? Reason { get; private set; }
    public bool StarvingRecovery { get; private set; }
    public bool Active => Owner != null;
    public bool Begin(string owner, long epoch, long now, bool starvingRecovery = false)
    {
        if (Active || epoch != Epoch) return false;
        Owner = owner; Until = now + HeartbeatMs; Sequence = 0; Reason = null; StarvingRecovery = starvingRecovery;
        return true;
    }
    public bool Frame(string owner, long sequence, long receivedAt, long now, int duration)
    {
        if (!Active || owner != Owner || sequence <= Sequence || receivedAt >= Until || duration is < 1 or > 500) return false;
        // The authorization heartbeat is independent of how briefly this
        // particular input should be held. Tight 180 ms steering frames still
        // need enough time for a bounded terrain replan before the next queued
        // refresh arrives; held keys retain their separate <=500 ms deadline.
        Sequence = sequence; Until = now + HeartbeatMs;
        return true;
    }
    public void Release(string reason) { Owner = null; Until = 0; Epoch++; Reason = reason; StarvingRecovery = false; }
    public bool Expire(long now)
    {
        if (!Active || now < Until) return false;
        Release("expired"); return true;
    }
    public object Observe(long now) => new { owner = Owner, epoch = Epoch, sequence = Sequence, reason = Reason,
        remainingMs = Math.Max(0, Until - now) };
}
