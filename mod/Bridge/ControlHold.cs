namespace VintageStoryAI;

public sealed class ControlHold
{
    // How long the inputs stay held with no frame from the controller before they release on their own:
    // a dead controller lets go within this; a render stall shorter than this does not throw the walk away.
    private const int HeartbeatMs = 5000;
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
    // Why a frame was refused, for the controller's log: each cause is a different fault.
    public string RefusalReason(string owner, long sequence, long receivedAt, int duration)
    {
        if (!Active) return $"Control frame refused: no hold ({Reason ?? "never begun"}).";
        if (owner != Owner) return "Control frame refused: another owner holds the inputs.";
        if (sequence <= Sequence) return $"Control frame refused: duplicate sequence {sequence} (at {Sequence}).";
        if (receivedAt >= Until) return $"Control frame refused: hold expired {receivedAt - Until} ms before it arrived.";
        return $"Control frame refused: duration {duration} ms is outside 1-500.";
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
