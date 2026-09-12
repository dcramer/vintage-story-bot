# Navigation

How a Seraph sees the ground and moves across it. The mod only senses and applies inputs; every route, memory and decision lives in Node. Mineflayer-pathfinder is the shape reference (goals, movement costs, partial paths, replan reasons), but it plans on a complete world the server hands the client. A Seraph plans on what its camera has seen, so it keeps memory at two resolutions and looks before it walks.

## Perception layers (mod → Node)

| Layer | Wire | Range | Content | Refresh |
| --- | --- | --- | --- | --- |
| Surroundings | `sense` / `control_step` terrain deltas | 8-block disk, 3 down / 6 up | Exact collision boxes and hazard flag per cell, camera-independent, line-of-sight-verified | ≤4 blocks every 0.5 s, rest every 1.5 s; changed cells invalidate at once |
| Far view | `sense` / `control_step` surface snapshot | Surroundings plus the client's real field of view, 64 by day down to 12 in the dark | One standing-surface sample per column: `y`, `ground|canopy|water|hazard`, block code; every column to 16, even to 32, multiples of four beyond | Sampled every tick while a controller listens, ≤2 ms/64 rays, 150 ms after the camera stops turning; snapshot = confirmed in the last 5 s inside the view; Node remembers 5 min |
| Entities and items | `sense` / `control_step` sightings snapshot | Seen inside the field of view to the light-limited radius; near within 8 all around; living entities heard within 16 all around | Key, code, point, how, time; item quantity | Every tick while a controller listens, ≤32 rays; snapshot = confirmed within 1 s; Node remembers entities 20 s, items 60 s |
| Watched blocks | same feed, `watch` attention list | On or within three cells of each visible surface column | Key, code, point, facts (name, variant, growth), access | Found as the eye sweeps; snapshot = confirmed within 8 s; Node remembers 5 min |
| Objects on demand | `scan` | 8 nearby, 64 cone | Explicit read of the current view, paged | Used only without the feed |

Rules that hold for every layer: perception is a snapshot of what the camera sees now, never a query, and memory is Node's alone; a sample exists only if a line of sight from the eye reached it; absent means unknown, never air; nothing below the visible surface, behind a ridge or in an unloaded chunk is reported; stale samples expire (surroundings 120 s in the mod, surface 5 min). The mod never plans or chooses where to look; Node turns the head and remembers what came into view.

## Memory (Node, `src/runtime/navigation/`)

- `TerrainMemory` (`terrain.mjs`): cells with absolute collision boxes from the near-field deltas, read as a block grid. A cell is a place to stand when it has a floor and a body's worth of known free cells above it; water, fire and unknown are walls. `moves(node)` lists the ways out: walk or step (up to 0.6) to any of eight neighbours, jump one block up or drop up to three along a cardinal, never a diagonal past something solid, never a drop beside water, extra cost beside water. `gapMoves` hops a one-cell hole as a last resort. `frontier(node)` is the unknown cells a move would need.
- `SurfaceMemory` (`surface.mjs`): far-field columns from the vision feed keyed by world coordinates so views from different spots merge. Answers coarse neighbours, shoreline adjacency and nearest known column.
- `SightingsMemory` (`sightings.mjs`): entities, items and watched blocks from the snapshots, visible now or remembered as last seen (20 s entities, 60 s items, 5 min blocks). `Fieldwork.scan` adds to the attention list, waits one sweep, and reads it; threats read `nearbyEntities`, which the game client overlays from this memory on every state.
- All live on the game client and, for terrain, surface and blocks, on disk per world (`knowledge.mjs`): loaded when the world's identifier is first observed, saved at most once a minute and on shutdown, kept for a week unless a block change is reported. The controller's eye loop refreshes them every 250 ms whether or not a goal is running. Entities and items are transient.

## Planning

Two planners, one contract: a route is a list of standing cells; every cell and every move between them came from observed blocks before the bot moves.

- **Corridor** (`planCorridor`): A* over seen columns toward a goal. Edges: adjacent columns follow the fine limits (jump up one, drop three); coarser rings only bound average slope. Water and hazard are never nodes; canopy and shoreline cost extra; 16×16 areas that already failed on the ground are penalized by the caller. Status `success` (goal column reached), `partial` (best visible progress; walk it and look again), `noPath`. Output is simplified to bends and 12-block spans.
- **Fine route** (`findRoute`): A* over standing cells using `moves` and, only where no ordinary move leaves that way, `gapMoves`; hostile-avoidance radii; edges blocked after stalls; a 250 ms deadline and a 1024-node budget. A goal beyond what has been seen yields a partial route to the frontier cell nearest the goal, as mineflayer-pathfinder does. A pit is nothing special: cells the search cannot leave never reach the goal.

## Walking (`Fieldwork.walk` → `Navigation`)

1. Target within 12 blocks: one fine leg.
2. Farther: turn toward the target and wait until the vision feed stops adding columns; if no `success` corridor, also glance ±50°. Plan a corridor; hand the fine navigator the farthest checkpoint within 40 blocks as a leg (`horizontalOnly`, arrival radius from the sample spacing). Arrive, look again from the new viewpoint, repeat (≤8 legs) until the target is within the horizon, then walk the final fine leg.
3. Nothing visible leads there: `blocked/no_visible_route` beyond 48 blocks (the caller's stall recovery takes over: foliage clearance, sneaking nudge, exploration legs), otherwise one direct fine leg.

`Navigation.tick` follows a route like a player: aim at the next cell and keep walking through bends of up to 60° (90° in the 180 ms frames used while turning or near a step); merge straight level runs into one checkpoint; jump when the next cell is a block up, from within 1.3 blocks and lined up; walk off a drop and release forward while airborne; sprint only on straight level runs with food; never crouch. A cliff guard refuses to walk toward any cell with nothing to stand on within a jump up or three blocks down unless it is the checkpoint itself. Re-plan in the same tick when the next cell stops being standable, and after 3 s without progress (the edge is then blocked for that goal). `surveying` looks at the unknown cells a move would need for up to 2.5 s before planning. Terminal: `arrived`, `blocked` (`no_observed_route`, `exploration_exhausted`, `deadline`, `lost_support`, replan limit), `cancelled` (damage, death, session or control change, `control_lost`), `yielded` (caller policy).

## Policies

Default all off, as pathfinder's `Movements` flags: no swimming, digging, placing, doors, or falls over three blocks. Leaf clearing is a stuck recovery in `leaf-clearing.mjs`, aimed at the real destination, never a routing primitive. Hostile avoidance (`threats.mjs`) replaces the target with a flee point while a seen, heard or recently seen hostile is inside its radius and resumes afterwards; a hostile behind a ridge and out of earshot is unknown, as it is to a player.

## Observability

`goal_status` progress phases: `walking`, `rough_route` / `no_rough_route` (with rough route status and the chosen leg), `rerouting` (reason), `route_cleared`, `probing`, `recovering_route`, `evading`. The dashboard `navigation` topic carries the live navigator view: state, reason, next checkpoint, yaw error, last replan, diagnostics (missing cells, support, clearance), threats.

## Verification

Synthetic checks in a scratchpad cover the rough route planner (lake skirted, ramp taken, partial beyond what was seen), the fine planner (diagonals, wall corner, pillar) and the seeing walk loop. Live gameplay is the real test: run `travel` at terrain that used to get stuck, watch `navigation.diagnostics` and the rough route phases, and record the outcome in the handoff.
