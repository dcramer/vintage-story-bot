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

        Check(PlacementPolicy.DestinationAvailable(true, true, true, false), "dry air accepts placement");
        Check(PlacementPolicy.DestinationAvailable(true, true, false, true), "a solid block may displace water");
        Check(!PlacementPolicy.DestinationAvailable(true, true, false, false), "non-displaced fluid is rejected");
        Check(!PlacementPolicy.DestinationAvailable(true, false, true, false), "an occupied solid layer is rejected");
        Check(!PlacementPolicy.DestinationAvailable(false, true, true, false), "an unloaded destination is rejected");
        Console.WriteLine($"{checks} placement-policy checks passed.");
    }
}
