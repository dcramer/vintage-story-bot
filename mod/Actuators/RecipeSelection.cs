namespace VintageStoryAI;

public static class RecipeSelection
{
    public static int SmallestBatch(IEnumerable<(int id, string? output, int quantity)> candidates, string output) =>
        candidates
            .Where(candidate => candidate.output == output)
            .OrderBy(candidate => candidate.quantity)
            .ThenBy(candidate => candidate.id)
            .Select(candidate => candidate.id)
            .DefaultIfEmpty(-1)
            .First();
}
