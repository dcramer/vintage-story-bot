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

        Check(PlacementPolicy.DestinationAvailable(true, true, null), "dry air accepts placement");
        Check(PlacementPolicy.DestinationAvailable(true, true, "water"), "water defers to native block placement");
        Check(!PlacementPolicy.DestinationAvailable(true, true, "lava"), "lava is rejected");
        Check(!PlacementPolicy.DestinationAvailable(true, false, null), "an occupied solid layer is rejected");
        Check(!PlacementPolicy.DestinationAvailable(false, true, null), "an unloaded destination is rejected");
        Console.WriteLine($"{checks} placement-policy checks passed.");
    }
}
