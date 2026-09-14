namespace VintageStoryAI;

internal static class PlacementPolicy
{
    public static bool DestinationAvailable(bool loaded, bool solidEmpty, string? liquidCode) =>
        loaded && solidEmpty && liquidCode != "lava";
}
