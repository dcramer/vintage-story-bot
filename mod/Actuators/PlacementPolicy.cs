namespace VintageStoryAI;

internal static class PlacementPolicy
{
    public static bool DestinationAvailable(bool loaded, bool solidEmpty, bool fluidEmpty, bool displacesWater) =>
        loaded && solidEmpty && (fluidEmpty || displacesWater);
}
