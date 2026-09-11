namespace VintageStoryAI;

public sealed class ControlLease
{
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
        Owner = owner; Until = now + 500; Sequence = 0; Reason = null; StarvingRecovery = starvingRecovery;
        return true;
    }
    public bool Frame(string owner, long sequence, long receivedAt, long now, int duration)
    {
        if (!Active || owner != Owner || sequence <= Sequence || receivedAt >= Until || duration is < 1 or > 500) return false;
        Sequence = sequence; Until = now + duration;
        return true;
    }
    public void Revoke(string reason) { Owner = null; Until = 0; Epoch++; Reason = reason; StarvingRecovery = false; }
    public bool Expire(long now)
    {
        if (!Active || now < Until) return false;
        Revoke("expired"); return true;
    }
    public object Observe(long now) => new { owner = Owner, epoch = Epoch, sequence = Sequence, reason = Reason,
        remainingMs = Math.Max(0, Until - now) };
}
