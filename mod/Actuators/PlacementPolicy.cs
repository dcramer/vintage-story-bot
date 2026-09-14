namespace VintageStoryAI;

internal static class PlacementPolicy
{
    public static bool DestinationAvailable(bool loaded, bool destinationReplaceable, string? liquidCode) =>
        loaded && destinationReplaceable && liquidCode != "lava";
}
