# Core bot API TODO

Rough spec of the bot API surface, modeled on [Mineflayer](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md) and [pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder), scoped to Vintage Story. Purpose: break work into small tasks. Analogues are design intent, not compatibility targets; see [bot-api-reference](docs/bot-api-reference.md) for the criteria each surface must meet.

Legend: `[x]` public action exists · `[~]` exists, not live-verified or known-broken · `[ ]` missing. Layer: `mod` (C# sensing/input), `game` (RPC client), `ctl` (controller schema/action), `skill`, `goal`. Priority: **P0** blocks day 1–2 of [getting-started](docs/getting-started.md), **P1** blocks day 3–5, **P2** later/quality. Implemented contracts: [actions](src/controller/actions.mjs).

## 1. State (`bot.entity`, `health`, `food`, `time`, `players`)

- [x] `observe` — identity, position, orientation, vitals, body condition, target, action timers.
- [x] `environment` — calendar, season, daylight, climate, wind, light.
- [x] `inventory` — hotbar/backpack/grid/mouse, equipment read-only, tool tiers, freshness.
- [x] `goal_status`, `api`.
- [ ] **P1 · `players`** — other players on server: name, distance, visible flag (`ctl`, `mod`). Mineflayer `bot.players`. Needed for co-op/follow.
- [x] `observe.nearbyEntities` — living entities ≤8 blocks; hostile allowlist and `nearestThreat` in [threats](src/skills/threats.mjs).
- [ ] **P2 · hostile sightings beyond 8 blocks** — `scan` entity results tagged hostile via the same allowlist, with last-seen tick (`ctl`).
- [ ] **P2 · `observe.time.untilSunset/untilDawn`** — derived from calendar so goals can budget daylight without recomputing (`ctl`).

## 2. Perception (`blockAt`, `findBlocks`, `canSeeBlock`, `blockAtCursor`, `nearestEntity`)

- [x] `scan` — awareness ≤8, cone sight ≤64, paged cursors, forage/ripe flags.
- [x] `inspect_target` — crosshair block/entity, HUD text, hints, forming state.
- [~] `aim_cell` — aim at cell/face/voxel by coordinates (uncommitted; verify on MP).
- [ ] **P1 · `block_at {x,y,z}`** — code/state of one cell if observed or remembered; `unknown` otherwise, never air (`game`, `ctl`). Mineflayer `blockAt`. Source: terrain memory + last scan; no hidden-world lookup.
- [ ] **P1 · `can_see {x,y,z}`** — sampled sightline from eye to cell (`mod`). Mineflayer `canSeeBlock`. Prerequisite for interact-range goals.
- [ ] **P1 · `find_blocks {match,radius,limit}`** — thin alias over `scan` with `kind:blocks` and remembered sightings merged, tagged observed/remembered (`ctl`). Mineflayer `findBlocks`.
- [ ] **P1 · `terrain {box}`** — read-only dump of navigation memory (walkable/hazard/unknown) for a bounded box (`ctl`). Lets the LLM reason about site selection (flat ground for house/kiln).
- [ ] **P2 · `ground_at {x,z}`** — highest known standable y in a column (`ctl`). Site picking, `travel` with omitted y.
- [ ] **P2 · entity detail** — `inspect_target` on entities: health if visible, hostile/passive class, tameable/harvestable hints (`mod`).

## 3. Controls (`setControlState`, `clearControlStates`, `look`, `lookAt`)

- [x] `move` — bounded forward/back/strafe/jump/sprint/sneak.
- [x] `look` — absolute yaw/pitch.
- [x] `select_hotbar`.
- [x] `stop` — global revoke.
- [ ] **P1 · `look_at {x,y,z}` / `{target:entity}`** — smooth aim at a point or tracked entity; entity form re-aims per frame while leased (`mod`). Mineflayer `lookAt`. Prerequisite for hunting.
- [ ] **P2 · `move` with `yaw`** — walk toward a heading in one frame instead of `look`+`move` (`ctl`).
- [ ] **P2 · held-input while re-aiming** — knapping drag and combat need aim changes during a hand lease; today `look` cancels hand actions. Decide: refuse forever (document) or allow bounded yaw delta under lease (`mod`).

## 4. Block interaction (`dig`, `stopDigging`, `placeBlock`, `activateBlock`)

- [x] `dig_block`, `place_block` — guarded single-cell, verified by client-observed change.
- [x] `attack_block`, `interact` — raw hold left/right click.
- [~] `use_on_block` — till/plant/water/ignite/sneak ground placement; not live-verified.
- [x] `dig_area`, `build` — multi-cell goals; `build` presets house/pit_kiln.
- [ ] **P0 · `place_block` on wall face at height** — verify torch-on-wall and gable placement (needs standing spot + up-face reach). Currently unverified for non-ground faces (`skill`).
- [ ] **P0 · `ignite {target}`** — firestarter/torch on pit kiln or firepit, verified by block-state change to burning (`skill`; probably `use_on_block` + `expectAfter`).
- [ ] **P1 · `door {target,open}`** — open/close doors and gates; navigation still excludes doors (`skill`, later `nav` movement flag). Mineflayer `openDoor`.
- [ ] **P1 · `pickup_ground {target}`** — right-click pickup of ground-stored stacks and loose items other than sticks (generalize `collect_stick`) (`skill`).
- [ ] **P2 · `dig_block` with drop collection option** — `collect:true` chains `collect_item` for the produced entity (`goal`).

## 5. Entity interaction (`attack`, `activateEntity`, `useOn`)

Nothing exists. Blocks day 2 hunting and all threat response.

- [ ] **P0 · `attack_entity {target,expectedKind,weapon?}`** — approach to melee range, aim, left-click until entity gone or fled; verify by entity disappearance + carcass/drop sighting (`mod` aim-at-entity, `skill`, `goal`). Mineflayer `attack`.
- [ ] **P0 · `throw {target}`** — spear throw: hold right-click with spear aimed at entity, verify spear count drop; pair with `collect_item` for retrieval (`skill`).
- [ ] **P1 · `activate_entity {target}`** — right-click entity: harvest carcass with knife, shear, milk (`mod`, `skill`). Mineflayer `activateEntity`.
- [x] hostile avoidance during navigation — 12-block detour, emergency sprint, resume after clear ([threats](src/skills/threats.mjs), navigator).
- [ ] **P1 · `flee {to?}`** — standalone reaction while stationary (waiting, crafting, forming): route to a POI or `fleeTarget`; same allowlist, runs only inside a task (`goal`).
- [ ] **P2 · sneak approach** — `travel` with `sneak:true` for animal approach (`ctl`, `nav`).

## 6. Inventory (`equip`, `unequip`, `toss`, `consume`, `recipesFor`, `craft`)

- [x] `equip` — by item or tool class/tier; empty hand.
- [x] `inventory_move`, `craft` (grid once), `craft_item` (verified loop), `recipes`.
- [x] `eat` — berries only.
- [ ] **P0 · bag/basket equipping** — handbasket/backpack into bag slots so capacity grows; today equipment is read-only (`mod`, `ctl`, `skill`). Blocks day 1 (2 handbaskets).
- [ ] **P0 · `eat` allowlist expansion** — mushrooms (safe list), cooked meat, bread, bowl of stew; per-food verification of satiety + item delta (`skill`).
- [ ] **P0 · `drop {item,count}`** — toss from own inventory to ground (spare cattails, stones as ground stacks) (`mod`, `ctl`). Mineflayer `toss`.
- [ ] **P1 · `equip` armor/offhand** — straw hat, improvised armor, offhand torch (`mod`, `ctl`).
- [ ] **P1 · `recipes` for knapping/clay/smithing** — list forming recipes and required material (`mod` FormingAdapter, `ctl`). Today grid only.
- [ ] **P1 · `item_info {code}`** — handbook facts: nutrition, tool class/tier, durability, fuel value, container capacity (`mod`, `ctl`).
- [ ] **P2 · `sort_inventory`** — consolidate stacks, hotbar layout policy (`skill`).

## 7. Containers (`openContainer`, `deposit`, `withdraw`, `close`)

Nothing exists. Blocks day 1 (chest storage) and day 4 (storage vessel, crock).

- [ ] **P0 · `open_container {target}`** — right-click chest/vessel/basket, return slots via `OpenedInventories` guard; session token like `inventory.state` (`mod`, `ctl`).
- [ ] **P0 · `container_move {from,to,quantity,expectedState}`** — extend `inventory_move` addresses with `container` while open (`mod`, `ctl`).
- [ ] **P0 · `close_container`** — explicit close; opening any goal auto-closes (`mod`, `ctl`).
- [ ] **P0 · `store {target,items[]}` / `take {target,items[]}`** — goal: walk, open, move, verify deltas, close (`skill`, `goal`).
- [ ] **P1 · firepit** — open, add fuel, add raw food, verify cooking state; extend `open_container` with firepit slots (`mod`, `skill`).
- [ ] **P1 · pit kiln loading** — pottery, 10 grass, 8 sticks, 4 fuel in order via sneak-place into pit; `build` preset already places the plus (`skill`, `goal`).
- [ ] **P2 · quern, crock sealing, bloomery** — later stations.

## 8. Crafting stations (Vintage Story specific)

- [~] `knap`, `clayform`, `select_recipe` — surface place + recipe select verified on MP; **knap does not convert to output at remaining 0** (client/server voxel desync suspected). Fix first (`mod`).
- [ ] **P0 · knap output conversion** — reproduce, confirm whether last chip must be server-observed; consider re-inspecting server state after each chip (`mod`).
- [ ] **P1 · knap efficiency** — clear recipe-adjacent boundary ring first so `tryBfsRemove` floods the bulk (`skill`).
- [ ] **P1 · `clayform` order policy** — vessel → pot → bowl sequencing helper (`goal`).
- [ ] **P2 · smithing** — anvil voxel work; same adapter family (`mod`, `skill`).

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
- [~] `travel`, `explore` — legs + detours; not live-verified.
- [x] `set_poi`, `pois` — session memory.
- [ ] **P0 · `GoalGetToBlock` / interact-range arrival** — `move_to {target:blockKey}` stops when the cell is in reach and visible, not at a coordinate (`nav`, `ctl`). Every block goal re-implements this today.
- [ ] **P1 · `GoalFollow` / `follow {target:entity,range}`** — track a moving entity, re-plan on movement (`nav`, `goal`). Hunting, co-op.
- [ ] **P1 · movement policy flags** — `allowSwim`, `allowJumpGap`, `allowDoors`, `allowDig` per goal; default all off (`nav`, `ctl`). pathfinder `Movements`.
- [ ] **P1 · `path_update` reasons on `goal_status`** — `noPath|timeout|stuck|replanned` phases with counts (`ctl`).
- [ ] **P1 · `home` shortcut** — `travel {poi:'home'}` convention plus `return_home` before sunset check (`skill`).
- [ ] **P2 · terrain memory persistence** — keyed by world identity, invalidated on reset; today session-only (`nav`).
- [ ] **P2 · ladder/climb, swim** — new movement primitives (`mod`, `nav`).

## 11. Survival and time

- [x] Food priority inside tasks (`manageFood`), attrition classification, low-vital interrupts.
- [x] `respawn`, `chat`.
- [ ] **P0 · `wait {untilHour|ms}`** — idle goal that holds position, keeps observing, stops on damage; nights indoors (`goal`).
- [ ] **P1 · torch cycle** — pick up and re-place torches each morning (`skill`): `dig_block` torch → `place_block`.
- [ ] **P1 · day plan goal** — composite `day1` goal chaining knap → cattails → chest → house, with per-step `goal_status` progress (`goal`). Decide whether composites live in Node or stay LLM-orchestrated.
- [ ] **P2 · sit/rest** — hunger reduction indoors; check API availability (`mod`).

## 12. Cross-cutting

- [ ] **P0 · live verification pass** — `use_on_block`, `travel`, `explore`, `fell_tree`, `knap`, `clayform`, `select_recipe` on the MP server; record outcomes in handoff, not docs.
- [ ] **P1 · unified target addressing** — accept `{x,y,z}` or block key everywhere a `target` is taken; keys stay the guard (`ctl`).
- [ ] **P1 · schema field alignment** — `timeoutMs`, `manageFood`, `sprint`, `count` defaults consistent across goals (`ctl`).
- [ ] **P2 · MCP tool count** — 40+ tools; consider grouping raw primitives (`move`, `look`, `interact`, `attack_block`, `select_hotbar`) behind an `advanced` flag in `api`.
