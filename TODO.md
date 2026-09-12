# Core bot API TODO

Rough spec of the bot API surface, modeled on [Mineflayer](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md) and [pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder), scoped to Vintage Story. Purpose: break work into small tasks. Mineflayer is the baseline for API shape only; every item must map to a real Vintage Story mechanic in the installed 1.22.7 assets ([capabilities](docs/capabilities.md)), never Minecraft behavior. See [bot-api-reference](docs/bot-api-reference.md) for the criteria each surface must meet.

Legend: `[x]` public action exists · `[~]` exists, not live-verified or known-broken · `[ ]` missing. Layer: `mod` (C# sensing/input), `game` (RPC client), `ctl` (controller schema/action), `support` (`src/support` helper), `goal`, `nav` (`src/runtime/navigation`). Priority: **P0** blocks day 1–2 of [getting-started](docs/getting-started.md), **P1** blocks day 3–5, **P2** later/quality. Implemented contracts: [actions](src/actions/), [goals](src/goals/).

## 1. State (`bot.entity`, `health`, `food`, `time`, `players`)

- [x] `observe` — identity, position, orientation, vitals, body condition, target, action timers.
- [x] `environment` — calendar, season, daylight, climate, wind, light.
- [x] `inventory` — hotbar/backpack/grid/mouse, equipment read-only, tool tiers, freshness.
- [x] `goal_status`, `goals` (recent records), `api`, `goal_script` (linear composite of existing goals), `brain`, `wants` (pickup list read/set).
- [x] `players` — other players on server: name, uid, position, distance, visible flag; tracking feed plus loaded entities.
- [~] `observe.nearbyEntities` — entities seen in the field of view, near within 8, or heard within 16 this instant; Node overlays 20 s memory; hostile allowlist and `nearestThreat` in [threats](src/support/threats.ts). Sight-limited path not live-verified.
- [ ] **P2 · `observe.time.untilSunset/untilDawn`** — derived from calendar so goals can budget daylight without recomputing (`ctl`).

## 2. Perception (`blockAt`, `findBlocks`, `canSeeBlock`, `blockAtCursor`, `nearestEntity`)

- [x] `scan` — surroundings ≤8, cone sight ≤64, paged cursors, block facts (name, variant, growth).
- [x] `target` — crosshair block/entity, HUD text, hints, forming state (wire `inspect_target`).
- [x] `aim_cell` — aim at a cell/face/voxel by coordinates using the block's real selection-box geometry; used by forming placement instead of caller-computed angles.
- [~] `block_at {x,y,z}` — one cell from memory: surroundings kind (unknown|air|solid|hazard, traits, age), the watched block sighted there (code, facts, access) and the far-view column; never air when unknown (`ctl`). Mineflayer `blockAt`. Not live-verified.
- [~] `can_see {x,y,z}` — one ray from the eye under the sweep's rules (8 blocks all around, farther only in view and in light; unloaded is unknown); `blockedBy` names the cell in the way (`mod`, `ctl`). Mineflayer `canSeeBlock`. Not live-verified.
- [~] sightings — `sense` returns a snapshot of entities, items and watched blocks a line of sight reached; a default salient set plus goal attention; `Fieldwork.scan` reads memory instead of paging `scan`; the controller's eye loop keeps memory fresh. Not live-verified.
- [~] look-around search — `Fieldwork.lookAround` turns through 360° and reads memory before exploring; `harvest` uses it. Still to do: `find_sticks`/`find_flint`/`find_cattails` example goals with a legible search (look around, nearest seen, walk, repeat; spiral outward, never revisit) replacing heading-based exploration (`support`, `goal`).
- [~] `sightings {match?,kind?,radius?,limit?,remembered?}` — what the eye has confirmed: entities, dropped items and watched blocks from `SightingsMemory.view`, visible or remembered with age and distance, nearest first; `Fieldwork.scan` reads the same view (`ctl`). Mineflayer `findBlocks`/`nearestEntity`/`entities`. Not live-verified.
- [~] `watch {list?}` — read or set the watch list, the sibling of `wants`; a running goal replaces it while it looks (`ctl`). Not live-verified.
- [~] `look_around` goal — one sweep of the head, then counts per code and the nearest objects from memory; `Fieldwork.lookAround` underneath. Not live-verified.
- [~] far view — `sense` returns a snapshot of sight-verified surface columns inside the real field of view (light-limited, coarser with distance); Node remembers them and `terrain` shows them. Not live-verified.
- [~] `terrain` — merged observed/seen surface view around a point; absent columns unknown. Not live-verified.
- [ ] **P2 · `ground_at {x,z}`** — one-column projection of the remembered `terrain` view; absent columns unknown, never air (`ctl`). Site picking, `travel` with omitted y.
- [ ] **P2 · entity detail** — `inspect_target` on entities: health if visible, hostile/passive class, tameable/harvestable hints (`mod`).
- [ ] **P2 · entity catalog** — creature/entity index for hunting (drops, hostility); the catalog covers blocks+items only today (`mod`, static or `ctl`).

## 3. Controls (`setControlState`, `clearControlStates`, `look`, `lookAt`)

- [x] `move` — bounded forward/back/strafe/jump/sprint/sneak.
- [x] `look` — absolute yaw/pitch.
- [x] `select_hotbar`.
- [x] `stop` — global release.
- [x] `look_at` — easing camera lock on an observed block, sighted entity or point; tracks moving entities, owns the camera until released.
- [ ] **P2 · `move` with `yaw`** — walk toward a heading in one frame instead of `look`+`move` (`ctl`).
- [ ] **P2 · held-input while re-aiming** — knapping drag and combat need aim changes during a hand action; today `look`/`aim_cell` cancel hand actions. Decide: refuse forever (document) or allow bounded yaw delta under a control hold (`mod`).
- [ ] **P1 · F8/camera-mode release** — the safety contract promises release on F8, but the mod only detects movement-key input; watch free-move camera mode, or narrow the doc (`mod`).
- [~] `close_dialog {dialog?}` — Escape delivered to one open native dialog (default the topmost that blocks control); dialogs that refuse to close stay open (`mod`, `ctl`). Not live-verified.
- [ ] **P2 · `aim_cell` reach from `pickingRange`** — today hardcoded to 8 blocks; use the player's native reach so aim and interaction agree (`mod`).

## 4. Block interaction (`dig`, `stopDigging`, `placeBlock`, `activateBlock`)

- [x] `dig_block`, `place_block` — guarded single-cell, verified by client-observed change.
- [x] `attack`, `interact` — raw hold left/right click.
- [~] `use_block` — till/plant/water/ignite/sneak ground placement; not live-verified. Sneak (shift) variants share the held-item shift-arming fix and the knap PAUSE until verified on MP.
- [x] `dig_area`, `build` — multi-cell goals; `build` presets house/pit_kiln.
- [ ] **P0 · `place_block` on wall face at height** — verify torch-on-wall and gable placement (needs standing spot + up-face reach). Currently unverified for non-ground faces (`support`).
- [ ] **P0 · `ignite {target}`** — firestarter/torch on pit kiln or firepit, verified by block-state change to burning (`support`; probably `use_block` + `expectAfter`).
- [ ] **P1 · `door {target,open}`** — open/close doors and gates; navigation still excludes doors (`support`, later `nav` movement flag). Mineflayer `openDoor`. Day 1 door is two hay bales, so `place_block`/`dig_block` covers that first.
- [ ] **P1 · `pickup_ground {target}`** — right-click pickup of ground-stored stacks and loose items other than sticks (generalize `gather_sticks`) (`support`).
- [~] `gather {match,item?,count}` — things lying on the ground: loose sticks, stones and flints by right-click, dropped stacks by walking over; replaces `gather_sticks` (`gather {match:'stick'}`); the brain uses it. Only the stick path is live-verified.
- [ ] **P2 · `dig_block` with drop collection option** — `collect:true` chains `collect_item` for the produced entity (`goal`).

## 5. Entity interaction (`attack`, `activateEntity`, `useOn`)

No attack/throw/butcher yet; `look_at` already locks and tracks entities, `players` lists server players, and hostile avoidance runs during navigation. Blocks day 2 hunting until attack lands.

- [ ] **P0 · `attack_entity {target,expectedKind,weapon?}`** — approach to melee range, aim, left-click until entity gone or fled; verify by entity disappearance + carcass/drop sighting (`support`, `goal`; mod side mostly present: `look_at` already locks/tracks entities). Mineflayer `attack`.
- [ ] **P0 · `throw {target}`** — spear throw: hold right-click with spear aimed at entity, verify spear count drop; pair with `collect_item` for retrieval (`support`).
- [ ] **P1 · `butcher {target}`** — VS `EntityBehaviorHarvestable`: hold right-click with a knife on a dead animal for its harvest time, then take drops from the harvest inventory it opens; depends on container access (§7) (`mod`, `support`). Mineflayer `activateEntity`.
- [ ] **P2 · `activate_entity {target}`** — other right-click uses: shear, milk, feed; taming is generational, never instant (`support`).
- [x] hostile avoidance during navigation — 12-block detour, emergency sprint, resume after clear ([threats](src/support/threats.ts), navigator).
- [ ] **P1 · `hunt {match,count?}`** — the outcome goal for [getting-started hunting](docs/getting-started.md#hunting): find a target of that kind, throw from range, let it run and calm, repeat, close with a club, then butcher and collect the drops; composes `throw`, `attack_entity`, `follow`, `butcher`, `collect_item` (`goal`). Days 2–5 each hunt one animal.
- [ ] **P1 · `flee {to?}`** — standalone reaction while stationary (waiting, crafting, forming): route to a waypoint or `fleeTarget`; same allowlist, runs only inside a task (`goal`). The default brain does this by hand today (`travel` to `fleeTarget`, arrivalRadius 3).
- [ ] **P2 · sneak approach** — `travel` with `sneak:true` for animal approach (`ctl`, `nav`).

## 6. Inventory (`equip`, `unequip`, `toss`, `consume`, `recipesFor`, `craft`)

- [x] `equip` — by item or tool class/tier; empty hand.
- [x] `move_item`, `craft` (grid once), `craft_item` (verified loop), `recipes`.
- [x] `eat` — berries only.
- [ ] **P0 · bag/basket equipping** — handbasket/backpack into bag slots so capacity grows; today equipment is read-only (`mod`, `ctl`, `support`). Blocks day 1 (2 handbaskets).
- [~] `eat` edibility from the tooltip — anything with positive saturation, no health loss, not psychedelic or intoxicating, fresh; optional `item` filter; no code lists. Not live-verified beyond berries (`support`).
- [ ] **P1 · nutrition-category policy** — VS max health follows fruit/vegetable/protein/grain/dairy saturation; `eat` picks by lowest category (`support`; mod side done: `inventory` exposes category per food, `observe.condition` the five levels).
- [ ] **P1 · freshness-aware eating** — prefer soonest-to-spoil; refuse rotten; `inventory.freshness` already exists (`support`).
- [x] `drop` — toss one owned slot (1 item or the whole stack) onto the ground; split partial stacks with `move_item` first.
- [ ] **P1 · `equip` clothing/armor/offhand** — character slots: warmth clothing for winter (body temperature), straw hat, improvised armor, offhand torch (`mod`, `ctl`).
- [ ] **P1 · `recipes` for knapping/clay/smithing** — list forming recipes and required material (`mod` FormingAdapter, `ctl`). Today grid only at runtime; static coverage via `search_items` (recipes baked per catalog entry). Live surface-aware listing still missing.
- [ ] **P2 · reverse recipe lookup (`usedIn`)** — recipes consuming a code, for "how do I get more of X / what is X for" planning; `search_items` bakes only `makes` today (`ctl`, static join over `docs/recipes.json`).
- [~] `item_info {code}` — handbook facts: nutrition, tool class/tier, durability, bag slots, fuel, drops, harvest yield and page text; `forage` reads it for every seen code ([facts](src/support/facts.ts)). Not live-verified.
- [ ] **P2 · handbook guide chapters** — the H-menu's tutorial/guide pages as data, completing the help-menu replication; guides are code/lang-driven, not file assets, so the source is still TBD (`mod` or static).
- [ ] **P2 · `sort_inventory`** — consolidate stacks, hotbar layout policy; sequencing over `move_item`, no new mod act (`support`).

## 7. Containers (`openContainer`, `deposit`, `withdraw`, `close`)

Blocks day 4 (storage vessel, crock) until firepit/vessel specifics land; the day-1 reed basket path is covered.

- [x] `open_container {target}` — right-click chest/vessel/basket, return slots via `OpenedInventories` guard; session token like `inventory.state`.
- [x] `move_container_item {from,to,quantity,expectedState}` — own slots plus `container` while open, guarded by the container session token.
- [x] `close_container` — explicit close via the manager's own sync packet; opening another container closes the first (goal auto-close is future work).
- [~] `store_items {target,items[]}` / `take_items {target,items[]}` — walk, open, move (merge first, then empty slots), verify counts on both sides, close. Not live-verified.
- [ ] **P1 · firepit** — not a furnace: fuel slot + input slot, or a cooking pot holding up to 4 ingredients making a meal per `recipes/cooking`; needs firestarter to light; verify burning/cooked state (`mod`, `support`).
- [ ] **P1 · `cook {item,count?}`** — outcome goal over the firepit: fuel in, ingredient or pot in, ignite, wait for the cooked state, take the result; day 1 night cooks poultry, day 4 makes stew (`goal`).
- [ ] **P1 · `fire_kiln {target}`** — load a built pit kiln (pottery, grass, sticks, fuel in order), ignite, wait the firing time while holding position, take fired pottery out; composes pit kiln loading, `ignite` and `wait` (`goal`). Day 3 fires, day 4 swaps.
- [ ] **P1 · ground storage piles** — sneak-place stackable items (logs, firewood, stones, cattails) as piles and pick them back up; 182 ground-storable items in assets (`support`).
- [ ] **P1 · `open_container` on bags** — handbaskets/backpacks worn in bag slots extend own inventory, they are not world containers; ensure `inventory` addresses cover bag slots (`mod`, `ctl`).
- [ ] **P1 · pit kiln loading** — pottery, 10 grass, 8 sticks, 4 fuel in order via sneak-place into pit; `build` preset already places the plus (`support`, `goal`).
- [ ] **P2 · barrel recipes** — tanning, pickling, lime; `recipes/barrel` (`support`).
- [ ] **P2 · quern, crock sealing, bloomery, crucible/alloy** — later stations.

## 8. Crafting stations (Vintage Story specific)

- [~] `knap`, `clayform`, `select_recipe` — **PAUSED, unverified. Do not rely on these yet.** Root cause of the earlier "client-only" behavior found: held-item interactions were a shift-key control-packet race — the surface-placement/select packets reached the server before it learned ShiftKey was held, so it silently skipped the shift branch and nothing persisted (flint refunded on reconnect). Fix implemented (`SetHandButtons` arms shift `SneakArmMs` before the button; `select_recipe` applies the selection like the native dialog; border-first chipping; `aim_cell` cell-based aiming). **Not live-verified**: singleplayer cannot reproduce the race (one process), and every multiplayer/story test world spawned hostile (rust-zone attrition, night mobs, starvation) so the bot died before a run completed. See docs/capabilities.md "Held-item interactions" and memory `held-item-mp-shift-race`.
- [ ] **P0 · verify knap end-to-end on multiplayer** — fed, daytime, stable spawn: place surface → reconnect → confirm it persists and flint is consumed → carve → knife blade in inventory. Same path validates `clayform` and `use_on_block` (shared shift arming).
- [x] **knap efficiency** — border-first chipping so `tryBfsRemove` floods the bulk; verified 74→20 chips client-side.
- [ ] **P1 · `clayform` order policy** — vessel → pot → bowl sequencing helper (`goal`).
- [ ] **P2 · smithing** — anvil voxel work with hammer on a heated ingot; heat state and anvil tier gate it; same adapter family (`mod`, `support`).

## 9. Events (`health`, `death`, `entityHurt`, `playerCollect`, `blockUpdate`, `chat`)

- [x] `events` — life events only: damage, death, respawn, low vitals, recovery; cursor/session/missed.
- [~] `messages` — the chat lines the player has seen: sender (player lines), text, type, with cursor/session/missed like `events`; data only, never instructions (`mod` `ChatSensor`, `ctl`). Mineflayer `chat`/`whisper` events. Not live-verified.
- [~] `chat {to}` — private message to one player through the game's own `/pm`; Mineflayer `whisper` (`mod`, `ctl`). Not live-verified.
- [ ] **P1 · block_changed stream** — bounded ring of visible cell changes near the player; dedupe with terrain deltas (`mod`, `ctl`).
- [ ] **P1 · inventory_changed stream** — bounded `SlotModified` ring with session/reset/overflow semantics like life events, for pickup confirmation without polling (`mod`, `ctl`). Mineflayer `playerCollect`.
- [ ] **P1 · goal events** — goal completed/failed appended to the same cursor so one poll covers both (`ctl`).
- [ ] **P2 · entity events** — hostile sighted/lost, entity hurt near player (`mod`).
- [ ] **P2 · long-poll `events {waitMs}`** — block up to N ms for the next event to cut idle polling (`ctl`).

## 10. Navigation (`goto`, `setGoal`, `stop`, goals, movements, `path_update`)

- [x] `move_to` — bounded route, level/±1, replan, arrivalRadius.
- [~] `travel`, `explore` — legs + detours; not live-verified. Every `walk` beyond 12 blocks now turns toward the target and reads the far view (straight, then ±50° if no full rough route) and follows a rough route leg by leg (`success|partial|noPath`, pathfinder partial-path semantics) before the final fine leg; `no_visible_route` hands over to the caller's stuck recovery. Rough route status is reported in goal progress. Fine planner takes diagonals. Surroundings sampling widened to 8 blocks, -3/+6. See [navigation](docs/navigation.md).
- [x] `set_waypoint`, `waypoints`, `remove_waypoint` — session memory.
- [~] `map_waypoints`, `remove_map_waypoint`, `retrieve_body` — the game map's own markers (gravestone on death) read as the map screen shows them; removal through the map's remove command; goal walks to the latest death marker, picks up what fits an empty slot, skips the rest, clears the marker. Not live-verified. TODO: pickup policy (partial stacks, priorities, making room), `died` event position fallback when the map is disabled.
- [~] `add_map_waypoint {title,x?,y?,z?,icon?,color?,pinned?}` — a marker on the game's own map through the map's `addati` command with absolute (`=`) coordinates, the pair of `remove_map_waypoint` (`mod`, `ctl`). Not live-verified: confirm the command's coordinate prefix and that the marker appears in `map_waypoints`.
- [~] `route {x,y?,z,arrivalRadius?}` — plan only: fine checkpoints from the surroundings (`success|partial|noPath`) and, beyond 12 blocks, the rough route over far-view columns; hostiles in memory avoided (`ctl`). pathfinder `getPathTo`. Not live-verified.
- [ ] **P0 · `GoalGetToBlock` / interact-range arrival** — `move_to {target:blockKey}` stops when the cell is within the player's native `pickingrange` and visible, not at a coordinate (`nav`, `ctl`). Every block goal re-implements this today.
- [ ] **P1 · `GoalFollow` / `follow {target:entity,range}`** — track a moving entity, re-plan on movement (`nav`, `goal`). Hunting, co-op.
- [~] **P0 · wading and swimming** — `travel` wades shallow water (wet nodes) and swims deep water by default (swim nodes: the body floats half a block under the surface cell's floor, a one-block bank is climbed with jump held, a fall of up to three blocks into deep water is allowed; `swim: false` forbids); the follower holds jump while the feet are wet and never sneaks there; with no goal running the core loop swims a floating bot to the nearest remembered dry ground. Wading live-verified 2026-09-12; swimming, oxygen and current still to verify live (`nav`, `skill`).
- [ ] **P1 · movement policy flags** — `allowJumpGap`, `allowDoors`, `allowDig` per goal; default all off (`nav`, `ctl`). pathfinder `Movements`.
- [ ] **P1 · `path_update` reasons on `goal_status`** — `noPath|timeout|stuck|replanned` phases with counts (`ctl`).
- [ ] **P1 · `home` shortcut** — `travel {waypoint:'home'}` convention plus `return_home` before sunset check (`support`).
- [~] terrain memory persistence — terrain, surface and remembered blocks per save identifier in `.runtime/knowledge`, week-long, invalidated by reported block changes. Not live-verified across a restart.
- [ ] **P2 · climbable blocks** — VS `Climbable` (ladders, some vines) as a movement primitive; VS auto-steps sub-block heights via `stepHeight`, full blocks still need jump (`mod`, `nav`).

### Known navigation problems (live, 2026-09-11/12)

- Fixed: a leaf (or any solid) inside a water-logged cell was reported as water, so a bot standing on a leaf at a pond's edge had no standable cell under its feet and every route failed; cells now carry traits (water, lava, fire, leaves, plant, climbable, shape, tierN) and only a cell with no solid in it is water.
- Fixed: the stuck-recovery nudge (a blind sneak-walk) is gone; it crouched the bot under water.
- Fixed: every drop beside water was refused, so a stream bank with a one-block step trapped the bot for twenty minutes (short partial route, frontier marked visited, then `no_observed_route` while probing hopped in place). Reproduced offline from `.runtime/knowledge/<save>.json` with `TerrainMemory` + `findRoute`; that is the way to work on the planner: capture, reproduce, fix, test, then walk it live.
- Open: rough-route legs end in `deadline` and `exploration_exhausted` on hillsides with 2–3 block cliffs and dense bushes (the leg deadline is 3 s/block; recovery wanders instead of climbing). Legs toward water-side targets fail with `no_observed_route` because cattails stand in water (see wading/swimming).
- Open: `harvest` walked 1343 blocks for 8 cattail tops; its search explores by heading with visit penalties and used to read only the current view. `lookAround` is a first step; a legible find loop is still to do (§2).
- Fixed: being hurt is an event (`hurt` in goal progress and the navigation view), not a stop; storms and life alerts likewise; the mod no longer releases control on damage or alerts.
- Open: the terrain view reports `observed` columns whose seenAt is days old on a save created the same day (`age` in `terrain` output); check the stamp source before trusting age-based forgetting.

## 11. Survival and time

- [x] Food priority inside tasks (`manageFood`), attrition classification, low-vital interrupts.
- [x] `respawn`, `chat`.
- [x] interrupt policy — damage, alerts and storms are events on the goal (`events` in progress) and the walk carries on; hard stops are death, lost controls, a changed player or world, deep water when a route forbids swimming. A pit ends `travel` with reason `pit` and `dig_out` is the brain's answer. Missing preconditions fail fast (`harvest` without its tool).
- [~] `wait {untilHour|ms}` — holds position and keeps observing; ends with reason `threat` when a hostile is seen or heard, at the game hour (past midnight when earlier than now) or after the milliseconds (`goal`). Not live-verified. Still to do: the default brain's `wait` job should run it instead of idling.
- [~] `shelter {item?,torch?}` — the tiny shelter as one goal (walls, walk in, seal, torch; blueprint in `support/structures.ts`); the brain's shelter job starts it and takes `result.home` (`goal`). Not live-verified.
- [ ] **P1 · torch cycle** — pick up and re-place torches each morning (`support`): `dig_block` torch → `place_block`.
- [~] day plan — the default brain (`src/brain/default.ts`, [brain](docs/brain.md)) walks days 1–2 on its own: danger, storm, hunger, night, shelter, then sticks, stone, tools, torches, logs; live on the multiplayer server 2026-09-12 (respawns, flees, forages). Not yet: shelter phases live, pottery, the full house.
- [ ] **P2 · sit** — VS sitting reduces hunger drain; useful during `wait` indoors (`mod`, `goal`).

## 11b. Vintage Story only (no Mineflayer analogue)

- [x] Temporal stability in `observe`, rust-world attrition classification.
- [x] Body condition: body temperature, wetness, freezing, tiredness, intoxication.
- [ ] **P1 · temporal storm awareness** — phase/strength/timing already in `observe.condition`/`environment`; still missing from the `events` stream, plus the policy: get indoors, no travel during storms (`mod` stream, `support`).
- [ ] **P1 · stability retreat** — when `temporalStability` keeps dropping, leave the low-stability region toward the last stable waypoint (`support`).
- [ ] **P1 · season/winter prep** — days-until-winter from calendar; goals for stored food and clothing warmth (`ctl`, `goal`).
- [ ] **P1 · `plant {item,x,z,count}`** — day 3 farming: till with a hoe, plant seeds, water; verify crop blocks appear; `use_block` already carries till/plant/water as primitives (`goal`). Harvesting grown crops is `harvest`.
- [ ] **P1 · rain vs pit kiln** — `environment` precipitation gates kiln firing, or build the full cover (`support`).
- [ ] **P2 · respawn point** — temporal gear use sets spawn; expose spawn status (`mod`, `support`).
- [ ] **P2 · panning** — pan on sand/gravel for nuggets; day 2 tool (`support`).
- [ ] **P2 · trader interaction** — VS traders replace villagers; buy/sell needs its own dialog adapter (`mod`).

Not planned (Minecraft-only): fishing, enchanting, furnace, villager trades, bed sleep (getting-started says never sleep).

## 12. Cross-cutting

- [ ] **P0 · live verification pass** — `use_block`, `travel`, `explore`, `fell_tree`, `knap`, `clayform`, `select_recipe` on the MP server; record outcomes in handoff, not docs.
- [ ] **P1 · unified target addressing** — accept `{x,y,z}` or block key everywhere a `target` is taken; keys stay the guard (`ctl`).
- [ ] **P1 · schema field alignment** — `timeoutMs`, `manageFood`, `sprint`, `count` defaults consistent across goals (`ctl`).
- [ ] **P2 · MCP tool count** — 40+ tools; consider grouping raw primitives (`move`, `look`, `interact`, `attack_block`, `select_hotbar`) behind an `advanced` flag in `api`.
