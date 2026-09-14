using VintageStoryAI;

static class PlacementPolicyTests
{
    public static void Run()
    {
        int checks = 0;
        void Check(bool condition, string name)
        {
            if (!condition) throw new Exception(name);
            checks++;
        }

        Check(PlacementPolicy.DestinationAvailable(true, true, null), "replaceable dry air accepts placement");
        Check(PlacementPolicy.DestinationAvailable(true, true, "water"), "replaceable water defers to native block placement");
        Check(!PlacementPolicy.DestinationAvailable(true, true, "lava"), "lava is rejected");
        Check(!PlacementPolicy.DestinationAvailable(true, false, null), "a non-replaceable destination is rejected");
        Check(!PlacementPolicy.DestinationAvailable(false, true, null), "an unloaded destination is rejected");
        Check(PlacementPolicy.OrientedHitCoordinate(10.5, 10) == 0.5, "orientation keeps an in-face eye coordinate");
        Check(PlacementPolicy.OrientedHitCoordinate(9, 10) == 0.05, "orientation clamps before the support face");
        Check(PlacementPolicy.OrientedHitCoordinate(12, 10) == 0.95, "orientation clamps beyond the support face");
        Console.WriteLine($"{checks} placement-policy checks passed.");
    }
}
