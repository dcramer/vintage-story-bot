# Core bot API TODO

Rough spec of the bot API surface, modeled on [Mineflayer](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md) and [pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder), scoped to Vintage Story. Purpose: break work into small tasks. Mineflayer is the baseline for API shape only; every item must map to a real Vintage Story mechanic in the installed 1.22.7 assets ([capabilities](docs/capabilities.md)), never Minecraft behavior. See [bot-api-reference](docs/bot-api-reference.md) for the criteria each surface must meet.

Legend: `[x]` public action exists · `[~]` exists, not live-verified or known-broken · `[ ]` missing. Layer: `mod` (C# sensing/input), `game` (RPC client), `ctl` (controller schema/action), `skill`, `goal`. Priority: **P0** blocks day 1–2 of [getting-started](docs/getting-started.md), **P1** blocks day 3–5, **P2** later/quality. Implemented contracts: [actions](src/actions/), [goals](src/goals/).

## 1. State (`bot.entity`, `health`, `food`, `time`, `players`)

- [x] `observe` — identity, position, orientation, vitals, body condition, target, action timers.
- [x] `environment` — calendar, season, daylight, climate, wind, light.
- [x] `inventory` — hotbar/backpack/grid/mouse, equipment read-only, tool tiers, freshness.
- [x] `goal_status`, `api`.
- [ ] **P1 · `players`** — other players on server: name, distance, visible flag (`ctl`, `mod`). Mineflayer `bot.players`. Needed for co-op/follow.
- [~] `observe.nearbyEntities` — entities seen in the field of view, near within 8, or heard within 16 this instant; Node overlays 20 s memory; hostile allowlist and `nearestThreat` in [threats](src/skills/threats.mjs). Sight-limited path not live-verified.
- [ ] **P2 · `observe.time.untilSunset/untilDawn`** — derived from calendar so goals can budget daylight without recomputing (`ctl`).

## 2. Perception (`blockAt`, `findBlocks`, `canSeeBlock`, `blockAtCursor`, `nearestEntity`)

- [x] `scan` — surroundings ≤8, cone sight ≤64, paged cursors, forage/ripe flags.
- [x] `inspect_target` — crosshair block/entity, HUD text, hints, forming state.
- [x] `aim_cell` — aim at a cell/face/voxel by coordinates using the block's real selection-box geometry; used by forming placement instead of caller-computed angles.
- [ ] **P1 · `block_at {x,y,z}`** — code/state of one cell if observed or remembered; `unknown` otherwise, never air (`game`, `ctl`). Mineflayer `blockAt`. Source: terrain memory + last scan; no hidden-world lookup.
- [ ] **P1 · `can_see {x,y,z}`** — sampled line of sight from eye to cell (`mod`). Mineflayer `canSeeBlock`. Prerequisite for interact-range goals.
- [~] sightings — `sense` returns a snapshot of entities, items and watched blocks a line of sight reached; a default salient set plus goal attention; `Fieldwork.scan` reads memory instead of paging `scan`; the controller's eye loop keeps memory fresh. Not live-verified.
- [ ] **P1 · `find_blocks {match,radius,limit}`** — controller-local read of remembered sightings, tagged visible/remembered (`ctl`). Mineflayer `findBlocks`.
- [~] far view — `sense` returns a snapshot of sight-verified surface columns inside the real field of view (light-limited, coarser with distance); Node remembers them and `terrain` shows them. Not live-verified.
- [~] `terrain` — merged observed/seen surface view around a point; absent columns unknown. Not live-verified.
- [ ] **P2 · `ground_at {x,z}`** — one-column form of `terrain` (`ctl`). Site picking, `travel` with omitted y.
- [ ] **P2 · entity detail** — `inspect_target` on entities: health if visible, hostile/passive class, tameable/harvestable hints (`mod`).

## 3. Controls (`setControlState`, `clearControlStates`, `look`, `lookAt`)

- [x] `move` — bounded forward/back/strafe/jump/sprint/sneak.
- [x] `look` — absolute yaw/pitch.
- [x] `select_hotbar`.
- [x] `stop` — global release.
- [ ] **P1 · `look_at {x,y,z}` / `{target:entity}`** — smooth aim at a point or tracked entity; entity form re-aims per frame while holding control (`mod`). Mineflayer `lookAt`. Prerequisite for hunting.
- [ ] **P2 · `move` with `yaw`** — walk toward a heading in one frame instead of `look`+`move` (`ctl`).
- [ ] **P2 · held-input while re-aiming** — knapping drag and combat need aim changes during a hand action; today `look` cancels hand actions. Decide: refuse forever (document) or allow bounded yaw delta under a control hold (`mod`).

## 4. Block interaction (`dig`, `stopDigging`, `placeBlock`, `activateBlock`)

- [x] `dig_block`, `place_block` — guarded single-cell, verified by client-observed change.
- [x] `attack_block`, `interact` — raw hold left/right click.
- [~] `use_on_block` — till/plant/water/ignite/sneak ground placement; not live-verified. Sneak (shift) variants share the held-item shift-arming fix and the knap PAUSE until verified on MP.
- [x] `dig_area`, `build` — multi-cell goals; `build` presets house/pit_kiln.
- [ ] **P0 · `place_block` on wall face at height** — verify torch-on-wall and gable placement (needs standing spot + up-face reach). Currently unverified for non-ground faces (`skill`).
- [ ] **P0 · `ignite {target}`** — firestarter/torch on pit kiln or firepit, verified by block-state change to burning (`skill`; probably `use_on_block` + `expectAfter`).
- [ ] **P1 · `door {target,open}`** — open/close doors and gates; navigation still excludes doors (`skill`, later `nav` movement flag). Mineflayer `openDoor`. Day 1 door is two hay bales, so `place_block`/`dig_block` covers that first.
- [ ] **P1 · `pickup_ground {target}`** — right-click pickup of ground-stored stacks and loose items other than sticks (generalize `collect_stick`) (`skill`).
- [ ] **P2 · `dig_block` with drop collection option** — `collect:true` chains `collect_item` for the produced entity (`goal`).

## 5. Entity interaction (`attack`, `activateEntity`, `useOn`)

Nothing exists. Blocks day 2 hunting and all threat response.

- [ ] **P0 · `attack_entity {target,expectedKind,weapon?}`** — approach to melee range, aim, left-click until entity gone or fled; verify by entity disappearance + carcass/drop sighting (`mod` aim-at-entity, `skill`, `goal`). Mineflayer `attack`.
- [ ] **P0 · `throw {target}`** — spear throw: hold right-click with spear aimed at entity, verify spear count drop; pair with `collect_item` for retrieval (`skill`).
- [ ] **P1 · `butcher {target}`** — VS `EntityBehaviorHarvestable`: hold right-click with a knife on a dead animal for its harvest time, then take drops from the harvest inventory it opens; depends on container access (§7) (`mod`, `skill`). Mineflayer `activateEntity`.
- [ ] **P2 · `activate_entity {target}`** — other right-click uses: shear, milk, feed; taming is generational, never instant (`skill`).
- [x] hostile avoidance during navigation — 12-block detour, emergency sprint, resume after clear ([threats](src/skills/threats.mjs), navigator).
- [ ] **P1 · `flee {to?}`** — standalone reaction while stationary (waiting, crafting, forming): route to a waypoint or `fleeTarget`; same allowlist, runs only inside a task (`goal`).
- [ ] **P2 · sneak approach** — `travel` with `sneak:true` for animal approach (`ctl`, `nav`).

## 6. Inventory (`equip`, `unequip`, `toss`, `consume`, `recipesFor`, `craft`)

- [x] `equip` — by item or tool class/tier; empty hand.
- [x] `inventory_move`, `craft` (grid once), `craft_item` (verified loop), `recipes`.
- [x] `eat` — berries only.
- [ ] **P0 · bag/basket equipping** — handbasket/backpack into bag slots so capacity grows; today equipment is read-only (`mod`, `ctl`, `skill`). Blocks day 1 (2 handbaskets).
- [ ] **P0 · `eat` allowlist expansion** — mushrooms (safe list), cooked meat, bread, bowl of meal; per-food verification of satiety + item delta (`skill`).
- [ ] **P1 · nutrition-category policy** — VS max health follows fruit/vegetable/protein/grain/dairy saturation; `eat` picks by lowest category, `inventory` exposes category per food (`mod`, `skill`).
- [ ] **P1 · freshness-aware eating** — prefer soonest-to-spoil; refuse rotten; `inventory.freshness` already exists (`skill`).
- [ ] **P0 · `drop {item,count}`** — toss from own inventory to ground (spare cattails, stones as ground stacks) (`mod`, `ctl`). Mineflayer `toss`.
- [ ] **P1 · `equip` clothing/armor/offhand** — character slots: warmth clothing for winter (body temperature), straw hat, improvised armor, offhand torch (`mod`, `ctl`).
- [ ] **P1 · `recipes` for knapping/clay/smithing** — list forming recipes and required material (`mod` FormingAdapter, `ctl`). Today grid only.
- [ ] **P1 · `item_info {code}`** — handbook facts: nutrition, tool class/tier, durability, fuel value, container capacity (`mod`, `ctl`).
- [ ] **P2 · `sort_inventory`** — consolidate stacks, hotbar layout policy (`skill`).

## 7. Containers (`openContainer`, `deposit`, `withdraw`, `close`)

Nothing exists. Blocks day 1 (chest storage) and day 4 (storage vessel, crock).

- [ ] **P0 · `open_container {target}`** — right-click chest/vessel/basket, return slots via `OpenedInventories` guard; session token like `inventory.state` (`mod`, `ctl`).
- [ ] **P0 · `container_move {from,to,quantity,expectedState}`** — extend `inventory_move` addresses with `container` while open (`mod`, `ctl`).
- [ ] **P0 · `close_container`** — explicit close; opening any goal auto-closes (`mod`, `ctl`).
- [ ] **P0 · `store {target,items[]}` / `take {target,items[]}`** — goal: walk, open, move, verify deltas, close (`skill`, `goal`).
- [ ] **P1 · firepit** — not a furnace: fuel slot + input slot, or a cooking pot holding up to 4 ingredients making a meal per `recipes/cooking`; needs firestarter to light; verify burning/cooked state (`mod`, `skill`).
- [ ] **P1 · ground storage piles** — sneak-place stackable items (logs, firewood, stones, cattails) as piles and pick them back up; 182 ground-storable items in assets (`skill`).
- [ ] **P1 · `open_container` on bags** — handbaskets/backpacks worn in bag slots extend own inventory, they are not world containers; ensure `inventory` addresses cover bag slots (`mod`, `ctl`).
- [ ] **P1 · pit kiln loading** — pottery, 10 grass, 8 sticks, 4 fuel in order via sneak-place into pit; `build` preset already places the plus (`skill`, `goal`).
- [ ] **P2 · barrel recipes** — tanning, pickling, lime; `recipes/barrel` (`skill`).
- [ ] **P2 · quern, crock sealing, bloomery, crucible/alloy** — later stations.

## 8. Crafting stations (Vintage Story specific)

- [~] `knap`, `clayform`, `select_recipe` — **PAUSED, unverified. Do not rely on these yet.** Root cause of the earlier "client-only" behavior found: held-item interactions were a shift-key control-packet race — the surface-placement/select packets reached the server before it learned ShiftKey was held, so it silently skipped the shift branch and nothing persisted (flint refunded on reconnect). Fix implemented (`SetHandButtons` arms shift `SneakArmMs` before the button; `select_recipe` applies the selection like the native dialog; border-first chipping; `aim_cell` cell-based aiming). **Not live-verified**: singleplayer cannot reproduce the race (one process), and every multiplayer/story test world spawned hostile (rust-zone attrition, night mobs, starvation) so the bot died before a run completed. See docs/capabilities.md "Held-item interactions" and memory `held-item-mp-shift-race`.
- [ ] **P0 · verify knap end-to-end on multiplayer** — fed, daytime, stable spawn: place surface → reconnect → confirm it persists and flint is consumed → carve → knife blade in inventory. Same path validates `clayform` and `use_on_block` (shared shift arming).
- [x] **knap efficiency** — border-first chipping so `tryBfsRemove` floods the bulk; verified 74→20 chips client-side.
- [ ] **P1 · `clayform` order policy** — vessel → pot → bowl sequencing helper (`goal`).
- [ ] **P2 · smithing** — anvil voxel work with hammer on a heated ingot; heat state and anvil tier gate it; same adapter family (`mod`, `skill`).

## 9. Events (`health`, `death`, `entityHurt`, `playerCollect`, `blockUpdate`, `chat`)

- [x] `events` — life events only: damage, death, respawn, low vitals, recovery; cursor/session/missed.
- [ ] **P1 · chat stream** — inbound `ChatMessage` ring: sender, text, at; data only, never instructions (`mod`, `ctl`). Mineflayer `chat`/`whisper` events.
- [ ] **P1 · block_changed stream** — bounded ring of visible cell changes near the player; dedupe with terrain deltas (`mod`, `ctl`).
- [ ] **P1 · inventory_changed stream** — `SlotModified` ring for pickup confirmation without polling (`mod`, `ctl`). Mineflayer `playerCollect`.
- [ ] **P1 · goal events** — goal completed/failed appended to the same cursor so one poll covers both (`ctl`).
- [ ] **P2 · entity events** — hostile sighted/lost, entity hurt near player (`mod`).
- [ ] **P2 · long-poll `events {waitMs}`** — block up to N ms for the next event to cut idle polling (`ctl`).

## 10. Navigation (`goto`, `setGoal`, `stop`, goals, movements, `path_update`)

- [x] `move_to` — bounded route, level/±1, replan, arrivalRadius.
- [~] `travel`, `explore` — legs + detours; not live-verified. Every `walk` beyond 12 blocks now turns toward the target and reads the far view (straight, then ±50° if no full rough route) and follows a rough route leg by leg (`success|partial|noPath`, pathfinder partial-path semantics) before the final fine leg; `no_visible_route` hands over to the caller's stuck recovery. Rough route status is reported in goal progress. Fine planner takes diagonals. Surroundings sampling widened to 8 blocks, -3/+6. See [navigation](docs/navigation.md).
- [x] `set_waypoint`, `waypoints` — session memory.
- [~] `map_waypoints`, `map_waypoint_remove`, `retrieve_body` — the game map's own markers (gravestone on death) read as the map screen shows them; removal through the map's remove command; goal walks to the latest death marker, picks up what fits an empty slot, skips the rest, clears the marker. Not live-verified. TODO: pickup policy (partial stacks, priorities, making room), `died` event position fallback when the map is disabled.
- [ ] **P0 · `GoalGetToBlock` / interact-range arrival** — `move_to {target:blockKey}` stops when the cell is within the player's native `pickingrange` and visible, not at a coordinate (`nav`, `ctl`). Every block goal re-implements this today.
- [ ] **P1 · `GoalFollow` / `follow {target:entity,range}`** — track a moving entity, re-plan on movement (`nav`, `goal`). Hunting, co-op.
- [ ] **P1 · movement policy flags** — `allowSwim`, `allowJumpGap`, `allowDoors`, `allowDig` per goal; default all off (`nav`, `ctl`). pathfinder `Movements`.
- [ ] **P1 · `path_update` reasons on `goal_status`** — `noPath|timeout|stuck|replanned` phases with counts (`ctl`).
- [ ] **P1 · `home` shortcut** — `travel {waypoint:'home'}` convention plus `return_home` before sunset check (`skill`).
- [~] terrain memory persistence — terrain, surface and remembered blocks per save identifier in `.runtime/knowledge`, week-long, invalidated by reported block changes. Not live-verified across a restart.
- [ ] **P2 · climbable blocks, swim** — VS `Climbable` (ladders, some vines) and water traversal as movement primitives; VS auto-steps sub-block heights via `stepHeight`, full blocks still need jump (`mod`, `nav`).

## 11. Survival and time

- [x] Food priority inside tasks (`manageFood`), attrition classification, low-vital interrupts.
- [x] `respawn`, `chat`.
- [ ] **P0 · `wait {untilHour|ms}`** — idle goal that holds position, keeps observing, stops on damage; nights indoors (`goal`).
- [ ] **P1 · torch cycle** — pick up and re-place torches each morning (`skill`): `dig_block` torch → `place_block`.
- [ ] **P1 · day plan goal** — composite `day1` goal chaining knap → cattails → chest → house, with per-step `goal_status` progress (`goal`). Decide whether composites live in Node or stay LLM-orchestrated.
- [ ] **P2 · sit** — VS sitting reduces hunger drain; useful during `wait` indoors (`mod`, `goal`).

## 11b. Vintage Story only (no Mineflayer analogue)

- [x] Temporal stability in `observe`, rust-world attrition classification.
- [x] Body condition: body temperature, wetness, freezing, tiredness, intoxication.
- [ ] **P1 · temporal storm awareness** — storm approaching/active in `observe`/`events`; policy: get indoors, no travel during storms (`mod`, `skill`).
- [ ] **P1 · stability retreat** — when `temporalStability` keeps dropping, leave the low-stability region toward the last stable waypoint (`skill`).
- [ ] **P1 · season/winter prep** — days-until-winter from calendar; goals for stored food and clothing warmth (`ctl`, `goal`).
- [ ] **P1 · rain vs pit kiln** — `environment` precipitation gates kiln firing, or build the full cover (`skill`).
- [ ] **P2 · respawn point** — temporal gear use sets spawn; expose spawn status (`mod`, `skill`).
- [ ] **P2 · panning** — pan on sand/gravel for nuggets; day 2 tool (`skill`).
- [ ] **P2 · trader interaction** — VS traders replace villagers; buy/sell needs its own dialog adapter (`mod`).

Not planned (Minecraft-only): fishing, enchanting, furnace, villager trades, bed sleep (getting-started says never sleep).

## 12. Cross-cutting

- [ ] **P0 · live verification pass** — `use_on_block`, `travel`, `explore`, `fell_tree`, `knap`, `clayform`, `select_recipe` on the MP server; record outcomes in handoff, not docs.
- [ ] **P1 · unified target addressing** — accept `{x,y,z}` or block key everywhere a `target` is taken; keys stay the guard (`ctl`).
- [ ] **P1 · schema field alignment** — `timeoutMs`, `manageFood`, `sprint`, `count` defaults consistent across goals (`ctl`).
- [ ] **P2 · MCP tool count** — 40+ tools; consider grouping raw primitives (`move`, `look`, `interact`, `attack_block`, `select_hotbar`) behind an `advanced` flag in `api`.
