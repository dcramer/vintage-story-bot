# Bot API design reference

Primary sources: [Mineflayer API](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md), [pathfinder API](https://github.com/PrismarineJS/mineflayer-pathfinder). Design analogues, not Vintage Story compatibility or an implementation checklist.

| Surface | Mineflayer examples | Seraph contract intent |
| --- | --- | --- |
| State | `entity`, `entities`, `inventory`, `health`, `food` | Structured snapshots; stable ids, session, observation time. |
| Perception | `blockAt`, `findBlocks`, `nearestEntity`, `canSeeBlock` | Separate cached knowledge, discovery and current visibility. Unknown ≠ empty. |
| Controls | `setControlState`, `clearControlStates`, `lookAt` | Atomic inputs under the control hold; smooth action-facing camera. |
| Interaction | `dig`, `stopDigging`, `placeBlock`, `activateBlock`, `attack` | Target/face guards; normal server validation; explicit interruption/outcome. |
| Inventory | `equip`, `toss`, `consume`, `recipesFor`, `craft` | Owned-slot/state guards; observe inventory deltas, not acknowledgements. |
| Containers | `openContainer`, window `deposit`/`withdraw` | Explicit open-session/slot ownership; no arbitrary inventory access. |
| Events | `physicsTick`, `health`, `entityHurt`, `playerCollect`, `blockUpdate` | Local reaction loop; bounded cursor events, loss detection/resync. |
| Navigation | `goto`, `setGoal`, `stop`, `GoalNear`, `GoalFollow`, `GoalGetToBlock` | Goal predicate separate from route; reach interaction range, not exact object center. |

- Pathfinder separates movement costs/permissions, incremental planning and `path_update`/`path_reset` reasons. Use bounded work, replan on changed terrain/targets; no implicit digging/placing to travel.
- Prioritize reusable approach → aim → interact → verify skills. Gathering orchestrates these; RPC exposes bounded primitives and goal lifecycle, not game-specific scripts in C#.
- Do not copy loaded-world access as eyesight. [Mineflayer block search](https://github.com/PrismarineJS/mineflayer/blob/master/lib/plugins/blocks.js) and [ray tracing](https://github.com/PrismarineJS/mineflayer/blob/master/lib/plugins/ray_trace.js) are separate. Seraph deliberately filters discovery by surroundings/line-of-sight constraints.
- Minecraft coordinates, physics, dig times, recipes and protocol are not transferable. Vintage Story engine remains authoritative. Public implemented contracts: [tool contracts](../src/actions/) and [goals](../src/goals/).
