# Navigation

How a Seraph sees the ground and moves across it. The mod only senses and applies inputs; every route, memory and decision lives in Node. Mineflayer-pathfinder is the shape reference (goals, movement costs, partial paths, replan reasons), but it plans on a complete world the server hands the client. A Seraph plans on what its camera has seen, so it keeps memory at two resolutions and looks before it walks.

## Perception layers (mod → Node)

| Layer | Wire | Range | Content | Refresh |
| --- | --- | --- | --- | --- |
| Near-field geometry | `sense` / `control_step` terrain deltas | 8-block disk, 3 down / 6 up | Exact collision boxes and hazard flag per cell, camera-independent, sightline-verified | ≤4 blocks every 0.5 s, rest every 1.5 s; changed cells invalidate at once |
| Far-field surface | `sense` / `control_step` surface deltas | 8-block ring plus the client's real field of view, 64 by day down to 12 in the dark | One standing-surface sample per column: `y`, `ground|canopy|water|hazard`, block code; every column to 16, even to 32, multiples of four beyond | Streamed every tick while a controller listens, ≤2 ms/64 rays; stale after 2 s, forgotten after 5 min |
| Entities and items | `sense` / `control_step` sightings deltas | Seen inside the field of view to the light-limited radius; near within 8 all around; living entities heard within 16 all around | Key, code, point, how, time; item quantity | Every tick while a controller listens, ≤32 rays; forgotten 20 s after last confirmation |
| Watched blocks | same feed, `watch` attention list | On or within three cells of each visible surface column | Key, code, point, forage state, access | Found as the eye sweeps; forgotten after 120 s |
| Objects on demand | `scan` | 8 nearby, 64 cone | Explicit read of the current view, paged | Used only without the feed |

Rules that hold for every layer: perception is a feed of what the camera sees now, never a query; a sample exists only if a sightline from the eye reached it; absent means unknown, never air; nothing below the visible surface, behind a ridge or in an unloaded chunk is reported; stale samples expire (near-field 120 s in the mod, surface 5 min). The mod never plans or chooses where to look; Node turns the head and remembers what came into view.

## Memory (Node, `src/navigation/`)

- `TerrainMemory` (`terrain.mjs`): cells with absolute collision boxes from the near-field deltas. Answers clearance, support, dryness and hazard distance for a body volume; `traverse` sweeps the body along a segment and is the only judge of whether a step is safe.
- `SurfaceMemory` (`surface.mjs`): far-field columns from the vision feed keyed by world coordinates so views from different spots merge. Answers coarse neighbours, shoreline adjacency and nearest known column.
- `SightingsMemory` (`sightings.mjs`): entities, items and watched blocks from the feed, visible now or remembered as last seen (60 s entities/items, 5 min blocks). `Fieldwork.scan` sets the attention list, waits one sweep, and reads it; threats read `observe.nearbyEntities`, which the mod derives from the same sightings.
- All live on the game client for the controller's lifetime and reset with the mod session. `terrain` exposes the merged surface view to the LLM; `pois` is the only named memory.

## Planning

Two planners, one contract: a route is a list of standing points; every point and every segment between them was validated against observation before the bot moves.

- **Corridor** (`planCorridor`): A* over seen columns toward a goal. Edges: adjacent columns follow the fine limits (jump up one, drop two); coarser rings only bound average slope. Water and hazard are never nodes; canopy and shoreline cost extra; 16×16 areas that already failed on the ground are penalized by the caller. Status `success` (goal column reached), `partial` (best visible progress; walk it and look again), `noPath`. Output is simplified to bends and 12-block spans.
- **Fine route** (`findRoute`): A* over standing points found in `TerrainMemory`, eight directions at real cost, jump-up-one, drop-two, one-cell gap jumps as marked escape edges, hostile-avoidance radii, edge blocking after stalls. Budget 512 nodes; partial routes end at a frontier whose next cells are unknown so the navigator can look at them.

## Walking (`Fieldwork.walk` → `Navigation`)

1. Target within 12 blocks: one fine leg.
2. Farther: turn toward the target and wait until the vision feed stops adding columns; if no `success` corridor, also glance ±50°. Plan a corridor; hand the fine navigator the farthest waypoint within 40 blocks as a leg (`horizontalOnly`, arrival radius from the sample spacing). Arrive, look again from the new viewpoint, repeat (≤8 legs) until the target is within the horizon, then walk the final fine leg.
3. Nothing visible leads there: `blocked/no_visible_route` beyond 48 blocks (the caller's stall recovery takes over: foliage clearance, sneaking nudge, exploration legs), otherwise one direct fine leg.

`Navigation.tick` runs each leg: `surveying` looks at the missing cells nearest the target for up to 2.5 s before planning; `moving` steers with bounded frames (500 ms, 180 ms near steps and bends), sneaks up to ledges, releases forward while airborne on descents, sprints only on straight level stretches with food, and replans on `stalled`, `jump_failed`, `terrain_changed`, `landing_changed`. Terminal: `arrived`, `blocked` (`no_observed_route`, `exploration_exhausted`, `deadline`, `lost_support`, replan limit), `cancelled` (damage, death, session or control change), `yielded` (caller policy such as food).

## Policies

Default all off, as pathfinder's `Movements` flags: no swimming, digging, placing, doors, or falls over two blocks. Foliage clearance is a stall recovery in `clearance.mjs`, aimed at the real destination, never a routing primitive. Hostile avoidance (`threats.mjs`) replaces the target with a flee point while a seen, heard or recently seen hostile is inside its radius and resumes afterwards; a hostile behind a ridge and out of earshot is unknown, as it is to a player.

## Observability

`goal_status` progress phases: `walking`, `corridor` / `no_corridor` (with corridor status and the chosen leg), `rerouting` (reason), `route_cleared`, `probing`, `recovering_route`, `evading`. The dashboard `navigation` topic carries the live navigator view: state, reason, next waypoint, yaw error, last replan, diagnostics (missing cells, support, clearance), threats.

## Verification

Synthetic checks in a scratchpad cover the corridor planner (lake skirted, ramp taken, partial beyond what was seen), the fine planner (diagonals, wall corner, pillar) and the seeing walk loop. Live gameplay is the real test: run `travel` at terrain that used to stall, watch `navigation.diagnostics` and the corridor phases, and record the outcome in the handoff.
