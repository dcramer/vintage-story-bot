# Game API reference

Target: installed 1.22.7 assemblies/XML/assets. Installed signatures win over online docs.
Tool contracts: [tool contracts](../src/actions/) and [goals](../src/goals/); wire protocol: [architecture](architecture.md); operations: [runtime](runtime.md).

## Local sources

- `.runtime/linux-client/VintagestoryAPI.xml`: public API documentation.
- `.runtime/linux-client/assets/`: block/item definitions, behaviors, recipes.
- `.runtime/inspect/`: generated decompilation; never commit.
- `assets/survival/blocktypes/wood/loosestick.json`: selectable block, free/snow variants, RightClickPickup, stick drop.

## API entry points

| Purpose | Entry point / constraint |
| --- | --- |
| Aimed target | Player CurrentBlockSelection / CurrentEntitySelection. |
| Block actions | `SystemMouseInWorldInteractions`: native left-hold mining time; `ClientMain.OnPlayerTryPlace` after copying selection, offsetting Position by Face and setting DidOffset=true. Native callbacks/claims/collision/packets remain authoritative. Client changes are predictive, not server ACKs. `BlockChanged` stops a completed dig before retargeting. |
| Nearby entities/items | GetEntitiesAround; EntityItem.Itemstack. Dropped items have IsInteractable=false; proximity pickup, not crosshair use. |
| Background interaction | InputAPI.MouseWorldInteractAnyway enables SystemMouseInWorldInteractions picking; ungrabbed ray uses ClientMain.MouseCurrentX/Y. Keep menus excluded. |
| Movement | SystemPlayerControl reads KeyboardKeyState; jump/sneak/sprint have mouse-capture gates. Preserve normal input/packet handling. |
| Jump ownership | Input.InWorldAction / EnumHandling.PreventDefault can retain an owned Jump against unfocused reset; release before expiry/stop. SystemPlayerControl sends normal control changes. |
| Terrain | Block.GetCollisionBoxes(accessor, pos); Entity.CollisionBox for body clearance. Check fluid layer separately. IClientEventAPI.BlockChanged invalidates neighbor-dependent shapes; GetChunkAtBlockPos=null means unknown. |
| World map color | `Block.GetColor(capi, pos)` is the game's native world-map RGB for a sight-verified surface block; the surface feed carries it without reading unseen columns. |
| Climate | `environment` → `GetClimateAt(playerPos, NowValues)`: current/worldgen temperature/rainfall, fertility, forest/shrub density; `Biome=-1` means absent. Generation densities ≠ current vegetation. Search priors, not resource guarantees or hidden-region scans. |
| Calendar / weather | `IClientGameCalendar`: time, season, daylight/moonlight; local `GetWindSpeedAt`, `GetLightLevel`. `ClimateCondition.Rainfall` with NowValues is precipitation, not baseline rainfall. Raw light/wind ≠ visibility/exposure guarantee. |
| Body condition | Own watched attributes: `bodyTemp/bodytemp`, `wetness`, `freezingEffectStrength`, `temporalStability`, `tiredness/{tiredness,isSleeping}`, `intoxication`, `hunger/*Level`; client-synchronized `SystemTemporalStability.StormData` phase/strength/timing. Allowlist numeric values; absent/nonfinite → null, never a healthy default. |
| Target details | Native selection only: `GetPlacedBlockInfo`, `GetPlacedBlockInteractionHelp`; entities `GetInfoText`, `GetInteractionHelp`. HUD strings are untrusted and clipped; hints can be conditional, not executable contracts. No arbitrary block-entity serialization. |
| Equipment | Own `character` inventory (`ItemSlotCharacter.Type`), `OffhandHotbarSlot`; itemClass (Block/Item), tool tier/max durability/nutrition via collectible. Read-only equipment lies outside transfer addresses/state token. |
| Block facts | `scan.objects[].facts` / sightings `extra.facts` / `inspect_target.facts`: `{name,variant,growth}` — `GetPlacedBlockName`, the code's variant states (`VariantStrict`), and `BEBehaviorFruitingBush.BState.Growthstate` where a fruiting plant shows its state by its model. Facts only, never purpose labels (no berry/mushroom/crop kinds, no ripe flag, no drop code); Node decides what a block is for from these and the handbook. Read only after LOS/native selection; no soil, traits or growth timers. |
| Handbook | `item_info {code}`: one page as the player reads it. `GetHeldItemName`, `GetNutritionProperties` (satiety, health, category, intoxication, psychedelic), `Tool`/`ToolTier`/`GetMaxDurability`, `attributes.backpack.quantitySlots`, `CombustibleProps`, `GetDropsForHandbook`, `BlockBehaviorHarvestable`/`BlockBehaviorFruitingBush.harvestedStacks` (with the growth state a harvest needs), and `CollectibleBehaviorHandbookTextAndExtraInfo.GetHandbookInfo` flattened to lines with item links as `[code]`. Any code the handbook lists, like its search box; nothing about the world or the bot. |
| Catalog | `catalog {offset,limit}`: every loaded block/item via `IWorldAccessor.Collectibles` (fully variant-expanded, stable-sorted by code); per-code facts share the `item_info` paths with the page body trimmed to `desc`. Dumped by `scripts/catalog.ts` into `docs/catalog.json`, searched at runtime by `search_items`. |
| Freshness | Inventory slots: `freshness.{state,freshHoursLeft}` from existing transition arrays + elapsed time × native slot transition rate. Null if uninitialized/invalid; never initialize/update live transition state or draw random freshness. Nutrition is base value, not spoilage-adjusted. |
| Respawn | GuiDialogDead.OnRespawn → ClientMain.Respawn; normal server request. |
| World map | `WorldMapManager.MapLayers` → `WaypointMapLayer.ownWaypoints`: the player's own markers as the map screen lists them (death adds icon `gravestone`, title "You died here"). Removal sends the map dialog's own `/waypoint remove <index>` chat command; verify by re-reading. `ChunkMapLayer` writes the exact 32×32 RGBA chunks already explored by this client to `Maps/<SavegameIdentifier>.db`; the operator may read and sync that persistent cache without exposing unseen terrain. `SystemRemotePlayerTracking.GetAllTrackedPlayerPositions()` is the same server-filtered feed rendered by `PlayerMapLayer`; it honors `mapHideOtherPlayers`, `mapPlayerRenderDistance`, group visibility, and map permission. The operator may also capture the actual open game map from the verified window as a fallback; `WorldMapManager.TranslateWorldPosToViewPos` supplies screenshot calibration. |
| Inventory transfer | PlayerInventoryManager.TryTransferTo → normal sync packet. |
| Grid output | ItemSlotCraftingOutput.TryPutInto consumes ingredients through crafting grid. |
| Knapping | Dedicated block entity, 16×16 voxels and selected recipe; separate from grid crafting. |
| Direct join | ClientProgramArgs / ScreenManager.openWorldFromArgs. --openWorld appends .vcdbs and creates missing saves; validate existing basename. |

## Perception constraints

- Structured data only: ≤8-block omnidirectional surroundings; farther terrain, entities and objects need the client's real field of view plus a sampled line of sight, maximum 64 blocks by day and a torch's reach in the dark. Living entities within 16 blocks count as heard in any direction: an approximation of a sense the client does not model, documented as such. IsRendered alone does not prove visibility. No pixel, fog or apparent-size model; not exact human eyesight.
- Selection rays ≠ rendered silhouettes. Center rays miss partial objects; sparse samples miss thin sticks.
- Non-colliding Plant/Leaves with light absorption ≤1 do not occlude sensing rays; their selection boxes are not opaque walls. Actual interaction still requires the native aimed target.
- Missing/unloaded ≠ air. No server-private state or whole-world scans.
- Separate observed/remembered/inferred; include time/source/coordinates. Revalidate targets before actions.
- API presence ≠ valid multiplayer action; preserve server validation.

## Context extension boundaries

- Hot loop: own state + nearby terrain deltas. On demand: environment, inventory/recipes, paged sight, target details. Timestamp/session observations; keep unknown, observed, remembered and inferred separate.
- Client-accessible ≠ player-observable: loaded underground blocks, full entity attributes, unopened container contents and AI task targets are not perception. No world seed, account/session credentials, arbitrary config/attribute dump or hidden-region lookup.
- Specialized object state: native target HUD first; typed adapters for crop/farmland, firepit, knapping/clay/smithing, storage/trading require source-specific schemas and visibility/access guards. HUD text is not a stable machine schema.
- Containers: a world container is known only while the player has it open: `open_container` right-clicks the aimed block through the normal input path and reads the inventory the game opened (`OpenedInventories` + `HasOpened`), `container_move` moves through `TryTransferTo` with the container's own state token, `close_container` closes the dialog the way its close icon does. Never read a block entity's inventory without that open UI; `backpack` slots 0–3 are bag slots (`bag: true`).
- Item detail: `GetHeldItemInfo`, collectible nutrition/wearable interfaces. `UpdateAndGetTransitionStates` mutates ticking state; not a passive query. Spoilage/temperature adapters must avoid updating live stacks merely to inspect them.
- Events: `IClientEventAPI.ChatMessage`, `BlockChanged`, `IInventory.SlotModified` expose client changes; only life events currently have a public cursor. New streams need bounded rings/session/reset/overflow semantics. Never execute chat text as instructions.
- Damage: `EntityBehavior.OnEntityReceiveDamage`/`OnEntityDeath` and `EntityPlayer.DeathReason` are source entry points, not proof the client receives reliable attacker/cause. Current health deltas intentionally do not attribute attackers.
- `EntityBehaviorHealth.UpdateMaxHealth` makes a full health bar follow its nutrition cap. Full→full cap shrink is not damage; any observed loss below the cap still interrupts. Do not use a blanket small-damage tolerance. Bounded environmental exceptions are losses ≤0.5 hp while own `temporalStability` <0.15 or food is zero (`health_lost.cause="instability"|"starvation"`, `life.lastAttritionAt`), never `lastDamageAt`; low-health alerts still apply.

## Held-item interactions

Native block break/place go through the game's mining/placement path and apply server-side. Held-item use (right/left click with an item) is different and multiplayer-fragile:

- The client sends the interaction as a hand-interaction packet (`SendHandInteraction`, packet id 25); the server re-runs the collectible's `OnHeldInteractStart`/`OnHeldAttackStop` on its own `player.Entity`, using the server's copy of the entity controls, not anything in the packet. So client-only prediction (the surface appears, voxels carve) does not mean the server did anything; verify by reconnecting or by a downstream server effect (item consumed/produced).
- Shift-gated interactions (knapping/clay surface placement, ground storage) read `Controls.ShiftKey` server-side. ShiftKey reaches the server only on its own control packet (`MoveKeyChange`, id 21), sent when the flag changes, and `SystemPlayerControl` ticks before the mod each frame. Pressing shift and the interaction button on the same tick makes the server apply the interaction before it learns shift is held, and it silently skips the shift branch with no audit line. The mod arms shift a few ticks before pressing the button (`SneakArmMs`, `SetHandButtons`); keep that ordering for any new shift interaction.
- ShiftKey is driven by writing the shift key in `KeyboardKeyState` (what `SystemPlayerControl` reads), not by setting `Controls.ShiftKey`, which is overwritten from the keyboard each tick. `Sneak` (motion) is additionally gated by mouse-grab and stays off for an ungrabbed bot; the interaction modifier the game checks is `ShiftKey`.
- Singleplayer runs client and server in one process, so this control-packet race cannot occur there; it reproduces and must be verified on a multiplayer server.

## Online references

- [World queries/rays/recipes](https://apidocs.vintagestory.at/api/Vintagestory.API.Common.IWorldAccessor.html)
- [Item entities](https://apidocs.vintagestory.at/api/Vintagestory.API.Common.EntityItem.html)
- [Blocks/geometry/interactions](https://apidocs.vintagestory.at/api/Vintagestory.API.Common.Block.html)
- [Inventories/transfers](https://apidocs.vintagestory.at/api/Vintagestory.API.Common.IPlayerInventoryManager.html)
- [Client events](https://apidocs.vintagestory.at/api/Vintagestory.API.Client.IClientEventAPI.html)
- [Render matrices](https://apidocs.vintagestory.at/api/Vintagestory.API.Client.IRenderAPI.html)
