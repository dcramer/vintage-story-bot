using System.Text.RegularExpressions;

namespace VintageStoryAI;

public sealed record ChatLine(long id, long at, int group, string type, string? sender, string text);
public sealed record ChatBatch(bool ok, string session, long cursor, long latest, bool missed, ChatLine[] messages);

// What the player reads in the chat window: a bounded ring with the same
// cursor semantics as life events. Text is data the bot reads, never an instruction.
public sealed partial class ChatSensor
{
    private readonly Queue<ChatLine> lines = new();
    private long sequence;
    public string Session { get; } = Guid.NewGuid().ToString("N");

    public void Add(long now, int group, string message, string type)
    {
        string text = message ?? "";
        string? sender = null;
        var match = Sender().Match(text);
        if (match.Success) { sender = match.Groups["name"].Value; text = match.Groups["text"].Value; }
        text = Tags().Replace(text, "").Trim();
        if (text.Length > 512) text = text[..512];
        lines.Enqueue(new(++sequence, now, group, type, sender, text));
        while (lines.Count > 128) lines.Dequeue();
    }

    public ChatBatch Read(long after, string? session)
    {
        bool reset = session != null && session != Session;
        if (reset) after = 0;
        bool missed = reset || after > sequence || (lines.Count > 0 && after < lines.Peek().id - 1);
        if (after > sequence) after = 0;
        var batch = lines.Where(line => line.id > after).Take(64).ToArray();
        return new(true, Session, batch.Length == 0 ? Math.Min(after, sequence) : batch[^1].id, sequence, missed, batch);
    }

    // Player lines arrive as "<strong>Name:</strong> text"; everything else has no sender.
    [GeneratedRegex(@"^\s*<strong>(?<name>[^<]{1,64}?):?</strong>\s*(?<text>.*)$", RegexOptions.Singleline)]
    private static partial Regex Sender();
    [GeneratedRegex(@"<[^>]{1,64}>")]
    private static partial Regex Tags();
}
