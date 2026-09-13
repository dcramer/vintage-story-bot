namespace VintageStoryAI;

public static class BlockHazards
{
    // The visible burning variant matters; firewood, fireclay and an unlit
    // firepit are not fire merely because their asset names contain it.
    public static bool Fire(bool fireMaterial, string? path) => fireMaterial || path == "firepit-lit";
}
