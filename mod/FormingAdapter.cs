using System.Reflection;
using System.Text.Json;
using Vintagestory.API.Client;
using Vintagestory.API.Common;
using Vintagestory.API.MathTools;
using Vintagestory.API.Util;
using Vintagestory.GameContent;

namespace VintageStoryAI;

// Typed adapter for knapping/clay-forming block entities: recipe list/selection and voxel deltas. Voxel clicks stay native.
public sealed class FormingAdapter(ICoreClientAPI api)
{
    private const int Cap = 64;
    private const double Reach = 5;

    public object? Describe(BlockPos pos, BlockSelection? selection) => api.World.BlockAccessor.GetBlockEntity(pos) switch
    {
        BlockEntityKnappingSurface knapping => DescribeKnapping(knapping, pos, selection),
        BlockEntityClayForm clay => DescribeClay(clay, pos, selection),
        _ => null,
    };

    private object DescribeKnapping(BlockEntityKnappingSurface be, BlockPos pos, BlockSelection? selection)
    {
        var recipe = be.SelectedRecipe;
        var extra = new List<int[]>();
        if (recipe != null)
            for (int x = 0; x < 16 && extra.Count < Cap; x++) for (int z = 0; z < 16 && extra.Count < Cap; z++)
                if (be.Voxels[x, z] && !recipe.Voxels[x, 0, z]) extra.Add([x, 0, z]);
        int remaining = 0;
        if (recipe != null) for (int x = 0; x < 16; x++) for (int z = 0; z < 16; z++) if (be.Voxels[x, z] != recipe.Voxels[x, 0, z]) remaining++;
        return new
        {
            kind = "knapping", material = be.BaseMaterial?.Collectible?.Code?.ToString(), layer = 0,
            recipe = recipe == null ? null : Recipe(recipe.RecipeId, recipe.Output),
            recipes = recipe == null ? KnappingRecipes(be.BaseMaterial).Select(r => Recipe(r.RecipeId, r.Output)).ToArray() : null,
            remaining, extra, missing = Array.Empty<int[]>(), aimedVoxel = AimedVoxel(pos, selection),
        };
    }

    private object DescribeClay(BlockEntityClayForm be, BlockPos pos, BlockSelection? selection)
    {
        var recipe = be.SelectedRecipe;
        int layer = 16, remaining = 0;
        var missing = new List<int[]>();
        var extra = new List<int[]>();
        if (recipe != null)
        {
            for (int l = 0; l < 16 && layer == 16; l++)
                for (int x = 0; x < 16 && layer == 16; x++) for (int z = 0; z < 16; z++)
                    if (be.Voxels[x, l, z] != recipe.Voxels[x, l, z]) { layer = l; break; }
            if (layer < 16)
                for (int x = 0; x < 16; x++) for (int z = 0; z < 16; z++)
                {
                    bool have = be.Voxels[x, layer, z], want = recipe.Voxels[x, layer, z];
                    if (have == want) continue;
                    remaining++;
                    if (want && missing.Count < Cap) missing.Add([x, layer, z]);
                    else if (!want && extra.Count < Cap) extra.Add([x, layer, z]);
                }
        }
        return new
        {
            kind = "clayforming", material = be.BaseMaterial?.Collectible?.Code?.ToString(), layer, availableVoxels = be.AvailableVoxels,
            recipe = recipe == null ? null : Recipe(recipe.RecipeId, recipe.Output),
            recipes = recipe == null ? ClayRecipes(be.BaseMaterial).Select(r => Recipe(r.RecipeId, r.Output)).ToArray() : null,
            remaining, extra, missing, aimedVoxel = AimedVoxel(pos, selection),
        };
    }

    private static object Recipe(int id, JsonItemStack output) =>
        new { id, output = output?.ResolvedItemstack?.Collectible?.Code?.ToString(), quantity = output?.ResolvedItemstack?.StackSize ?? output?.Quantity };

    private int[]? AimedVoxel(BlockPos pos, BlockSelection? selection)
    {
        if (selection == null || selection.Position != pos) return null;
        var boxes = api.World.BlockAccessor.GetBlock(pos).GetSelectionBoxes(api.World.BlockAccessor, pos);
        int index = selection.SelectionBoxIndex;
        if (boxes == null || index < 0 || index >= boxes.Length) return null;
        var box = boxes[index];
        return [(int)(16f * box.X1), (int)(16f * box.Y1), (int)(16f * box.Z1)];
    }

    private bool CanDo(IRecipeBase recipe, ItemStack ingredient) =>
        api.Event.TriggerMatchesRecipe(api.World.Player, recipe, [new DummySlot(ingredient)]);

    private IEnumerable<KnappingRecipe> KnappingRecipes(ItemStack? material) => material == null ? [] :
        api.GetKnappingRecipes().Where(r => r.Ingredient.SatisfiesAsIngredient(material, true) && CanDo(r, material))
            .OrderBy(r => r.Output.ResolvedItemstack.Collectible.Code).Take(Cap);

    private IEnumerable<ClayFormingRecipe> ClayRecipes(ItemStack? material) => material == null ? [] :
        api.GetClayformingRecipes().Where(r => r.Ingredient.SatisfiesAsIngredient(material, true) && CanDo(r, material))
            .OrderBy(r => r.Output.ResolvedItemstack.Collectible.Code).Take(Cap);

    // Select a recipe on a surface the player created; replaces the native selection dialog with the same packet.
    public object SelectRecipe(JsonElement request)
    {
        if (!request.TryGetProperty("target", out var targetField) || targetField.ValueKind != JsonValueKind.String)
            return new { ok = false, error = "Supply target block key and recipe id or output code." };
        int recipeId = -1;
        string? output = null;
        if (request.TryGetProperty("recipe", out var recipeField) && !recipeField.TryGetInt32(out recipeId)) return new { ok = false, error = "recipe must be an integer id." };
        if (request.TryGetProperty("output", out var outputField)) output = outputField.GetString();
        if (recipeId < 0 && output == null) return new { ok = false, error = "Supply recipe id or output code." };
        var parts = targetField.GetString()!.Split(':');
        if (parts.Length < 6 || parts[0] != "block" || !int.TryParse(parts[1], out int dimension) || dimension != 0 ||
            !int.TryParse(parts[2], out int x) || !int.TryParse(parts[3], out int y) || !int.TryParse(parts[4], out int z))
            return new { ok = false, error = "Invalid block key." };
        var entity = api.World.Player.Entity;
        if (!entity.Alive || api.IsGamePaused) return new { ok = false, error = "Cannot select while dead or paused." };
        var pos = new BlockPos(x, y, z, 0);
        if (entity.Pos.DistanceTo(pos.ToVec3d().Add(.5, .5, .5)) > Reach) return new { ok = false, error = "Surface out of reach." };
        var be = api.World.BlockAccessor.GetBlockEntity(pos);
        ItemStack? material;
        bool selected;
        IEnumerable<(int id, string? output)> allowed;
        switch (be)
        {
            case BlockEntityKnappingSurface knapping:
                material = knapping.BaseMaterial; selected = knapping.SelectedRecipe != null;
                allowed = KnappingRecipes(material).Select(r => (r.RecipeId, r.Output?.ResolvedItemstack?.Collectible?.Code?.ToString())); break;
            case BlockEntityClayForm clay:
                material = clay.BaseMaterial; selected = clay.SelectedRecipe != null;
                allowed = ClayRecipes(material).Select(r => (r.RecipeId, r.Output?.ResolvedItemstack?.Collectible?.Code?.ToString())); break;
            default:
                return new { ok = false, error = "Target is not a knapping surface or clay form." };
        }
        if (selected) return new { ok = false, error = "Recipe already selected." };
        var held = api.World.Player.InventoryManager.ActiveHotbarSlot?.Itemstack;
        if (material == null || held == null || held.Collectible.Code != material.Collectible.Code)
            return new { ok = false, error = "Hold the surface's base material." };
        var candidates = allowed.ToArray();
        if (recipeId < 0) recipeId = candidates.FirstOrDefault(c => c.output == output, (-1, null)).id;
        if (!candidates.Any(c => c.id == recipeId)) return new { ok = false, error = "Recipe not available for this material; inspect_target lists recipes." };
        foreach (var dialog in api.Gui.OpenedGuis.OfType<GuiDialogBlockEntityRecipeSelector>().ToArray())
        {
            // The native dialog cancels (and destroys the surface) unless it believes a selection happened.
            var flag = typeof(GuiDialogBlockEntityRecipeSelector).GetField("didSelect", BindingFlags.Instance | BindingFlags.NonPublic);
            if (flag == null) return new { ok = false, error = "Recipe dialog open and cannot be closed safely." };
            flag.SetValue(dialog, true);
            dialog.TryClose();
        }
        api.Network.SendBlockEntityPacket(pos, 1001, SerializerUtil.Serialize(recipeId));
        return new { ok = true, status = "submitted", recipe = recipeId, target = targetField.GetString() };
    }
}
