# Game API reference

Target: installed 1.22.7 assemblies/XML/assets. Installed signatures win over online docs.
Tool contracts: [schemas](../src/controller/actions.mjs); wire protocol: [architecture](architecture.md); operations: [runtime](runtime.md).

## Local sources

- `.runtime/linux-client/VintagestoryAPI.xml`: public API documentation.
- `.runtime/linux-client/assets/`: block/item definitions, behaviors, recipes.
- `.runtime/inspect/`: generated decompilation; never commit.
- `assets/survival/blocktypes/wood/loosestick.json`: selectable block, free/snow variants, RightClickPickup, stick drop.

## API entry points

| Purpose | Entry point / constraint |
| --- | --- |
| Aimed target | Player CurrentBlockSelection / CurrentEntitySelection. |
| Nearby entities/items | GetEntitiesAround; EntityItem.Itemstack. Dropped items have IsInteractable=false; proximity pickup, not crosshair use. |
| Background interaction | InputAPI.MouseWorldInteractAnyway enables SystemMouseInWorldInteractions picking; ungrabbed ray uses ClientMain.MouseCurrentX/Y. Keep menus excluded. |
| Movement | SystemPlayerControl reads KeyboardKeyState; jump/sneak/sprint have mouse-capture gates. Preserve normal input/packet handling. |
| Jump ownership | Input.InWorldAction / EnumHandling.PreventDefault can retain an owned Jump against unfocused reset; release before expiry/stop. SystemPlayerControl sends normal control changes. |
| Terrain | Block.GetCollisionBoxes(accessor, pos); Entity.CollisionBox for body clearance. Check fluid layer separately. IClientEventAPI.BlockChanged invalidates neighbor-dependent shapes; GetChunkAtBlockPos=null means unknown. |
| Respawn | GuiDialogDead.OnRespawn → ClientMain.Respawn; normal server request. |
| Inventory transfer | PlayerInventoryManager.TryTransferTo → normal sync packet. |
| Grid output | ItemSlotCraftingOutput.TryPutInto consumes ingredients through crafting grid. |
| Knapping | Dedicated block entity, 16×16 voxels and selected recipe; separate from grid crafting. |
| Direct join | ClientProgramArgs / ScreenManager.openWorldFromArgs. --openWorld appends .vcdbs and creates missing saves; validate existing basename. |

## Perception constraints

- Structured data first; bound range/results and filter view/occlusion. IsRendered alone does not prove visibility.
- Selection rays ≠ rendered silhouettes. Center rays miss partial objects; sparse samples miss thin sticks.
- Non-colliding Plant/Leaves with light absorption ≤1 do not occlude sensing rays; their selection boxes are not opaque walls. Actual interaction still requires the native aimed target.
- Missing/unloaded ≠ air. No server-private state or whole-world scans.
- Separate observed/remembered/inferred; include time/source/coordinates. Revalidate targets before actions.
- API presence ≠ valid multiplayer action; preserve server validation.

## Online references

- [World queries/rays/recipes](https://apidocs.vintagestory.at/api/Vintagestory.API.Common.IWorldAccessor.html)
- [Item entities](https://apidocs.vintagestory.at/api/Vintagestory.API.Common.EntityItem.html)
- [Blocks/geometry/interactions](https://apidocs.vintagestory.at/api/Vintagestory.API.Common.Block.html)
- [Inventories/transfers](https://apidocs.vintagestory.at/api/Vintagestory.API.Common.IPlayerInventoryManager.html)
- [Client events](https://apidocs.vintagestory.at/api/Vintagestory.API.Client.IClientEventAPI.html)
- [Render matrices](https://apidocs.vintagestory.at/api/Vintagestory.API.Client.IRenderAPI.html)
