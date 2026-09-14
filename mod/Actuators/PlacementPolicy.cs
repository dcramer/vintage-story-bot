namespace VintageStoryAI;

internal static class PlacementPolicy
{
    public static bool DestinationAvailable(bool loaded, bool destinationReplaceable, string? liquidCode) =>
        loaded && destinationReplaceable && liquidCode != "lava";

    // SuggestedHVOrientation compares the player's eye with the selected point
    // on the support block. Align the perpendicular coordinate with the eye so
    // a cardinally positioned player deterministically chooses the requested
    // n/w axis without bypassing native placement.
    public static double OrientedHitCoordinate(double eye, int support) =>
        Math.Clamp(eye - support, 0.05, 0.95);
}
