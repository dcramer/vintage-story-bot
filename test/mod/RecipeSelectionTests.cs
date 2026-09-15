using VintageStoryAI;

static class RecipeSelectionTests
{
    public static void Run()
    {
        void Check(bool value, string name) { if (!value) throw new Exception(name); }
        var recipes = new[]
        {
            (id: 40, output: (string?)"game:claypot-red-raw", quantity: 4),
            (id: 11, output: (string?)"game:claypot-red-raw", quantity: 1),
            (id: 7, output: (string?)"game:bowl-red-raw", quantity: 1),
        };

        Check(RecipeSelection.SmallestBatch(recipes, "game:claypot-red-raw") == 11, "single-item recipe wins over batch recipe");
        Check(RecipeSelection.SmallestBatch(recipes, "game:missing") == -1, "unknown output is rejected");
        Console.WriteLine("2 recipe-selection checks passed.");
    }
}
