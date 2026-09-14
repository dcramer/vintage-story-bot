namespace VintageStoryAI;

public static class BlockHazards
{
    // The visible burning variant matters; firewood, fireclay and an unlit
    // firepit are not fire merely because their asset names contain it.
    public static bool Fire(bool fireMaterial, string? path) => fireMaterial || path == "firepit-lit";

    // Connected structures can report collision outside their owning cell.
    // Keep closed fences conservative, but an explicitly opened block is a
    // passage; TerrainSensor omits its edge/hinge collision for navigation.
    public static bool OverflowingShape(bool overflowsCell, bool opened) => overflowsCell && !opened;
}
