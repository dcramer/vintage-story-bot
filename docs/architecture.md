# Runtime boundaries

`MCP/CLI → controller:42158 → mod:42157 → game inputs/physics`

| Path | Responsibility |
| --- | --- |
| `src/bridge/` | Bounded game transport; no retries. |
| `src/game/` | Game RPC client: terrain cursors, scoped control owners/sequences/cleanup. |
| `src/controller/` | Shared service, public schemas, Effect goal lifecycle/exclusion. |
| `src/navigation/` | Terrain memory, route planning, exploration, steering policy; no I/O. |
| `src/goals/` | Goal registry and task policies; injected game/skill API. |
| `src/skills/` | Composable fieldwork, harvesting/eating and survival priority; shared session guards/memory. |
| `src/mcp/` | MCP adapter only. `src/mcp-server.mjs` preserves registrations. |
| `src/operator/` | Human/operator UI utilities; never import from gameplay or MCP. |
| `mod/` | Visible sensing, input execution, smooth aiming, guard/expiry enforcement. |

- Controller/goals/navigation cannot use screenshots, UI tools, OS focus, or hidden world queries.
- One shared controller, one active goal. START ≠ completion; observe ids. Restart cancels goals; never auto-resume. Memory is ephemeral.
- Effect owns interruption/finalizers; mod deadlines remain independent. Never retry mutations, including frames. [Finalization reference](https://effect.website/docs/v3/resource-management/introduction).

## Design intent

- Mod = sensors/actuators, not a planner. Game owns physics, collision, inventory and server validation. Node owns routes, memory, goals and reaction policies; edit/restart Node without reloading the game.
- Follow [Mineflayer](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md)'s state/control separation and [pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)'s independent goals, movement policy and outcomes; do not reproduce Minecraft physics or assume its world visibility.
- Skills compose inside one controller-owned goal. Add handlers to `src/goals/registry.mjs` and public contracts to `src/controller/actions.mjs`; MCP/CLI/discovery share those contracts. No arbitrary code-loading RPC.
- Keep the fast loop local: structured observations → Node decision → bounded input frame. LLM/MCP assigns goals, not individual walking ticks. Perception is approximate visible knowledge, not omniscience; unknown ≠ air, stale ≠ safe.
- Mod owns immediate safety revocation even if Node stalls. Node decides subsequent reactions; cancellation completes cleanup before another goal runs. Do not auto-resume after damage/death/restart.
- Transport acknowledgement is not gameplay completion. Verify arrival, inventory deltas and life state. Lost replies imply uncertain effects; inspect, never blindly resend.
- Memory must be session-scoped, bounded and invalidatable. Share observations across skills; geometry, resource sightings and failed approaches have different expiry rules. No persistence until world identity/invalidation are defined.
- Prefer this small client/skills/goals split over a second game engine, screenshot loops, or a generic workflow framework.
- Survival runs only inside an assigned task, not an idle autonomous process. Food priority yields navigation on supported ground; lease cleanup precedes eating/foraging. Planned yields preserve parent progress; damage/death/session changes abort the entire task. Thresholds/allowlists live in `src/skills/`.

## Controller RPC

Loopback JSON line: `{action,...args}` → `{ok,...result}` or `{ok:false,error,...}`. One request/connection; ≤1024 request bytes including newline, ≤262144 response bytes. No replay/retry protocol. Mod wire stays private; MCP/CLI use controller actions only.

- `api {}`: schemas, descriptions, execution kind (`query|command|goal`), controller session. No game I/O.
- Goal actions return `{goal:{id,...},controller,...}`; successful START means accepted, not completed. `move_to` also returns legacy `navigation`.
- `goal_status {id?}`: latest or retained goal, `args` (parsed request), timestamps (UTC ms), state/progress/result, `active`, controller session. No game I/O or waiting behind game startup. Last 64 completed goals; unknown/evicted/restarted id → `goal_not_found`, never inferred success.
- `active` remains true through finalization. States: `starting|running`, navigation phases, `arrived|blocked|cancelled`; arrival is success only after cleanup. Controller session changes on restart; history is not durable.
- `stop {expectedGoal?}`: guarded cancellation of current/latest goal; no guard = global stop. Reject mismatched id. Separate stop/start deliberately avoids implicit replacement races.
- `events` remains the mod's bounded life-event cursor API, separate from goal status. Resync after missed events. Polling never wakes an idle LLM.

## Telemetry

Controller → dashboard `POST /ingest` on `127.0.0.1:42159`: one long-lived chunked request of NDJSON lines `{topic,at,data,log}`; `at` is UTC ms, `log:true` appends to the dashboard event log, otherwise only the latest value per topic is kept. Fire-and-forget: bounded queue, coalesced fast topics, 2s reconnect, never awaited by gameplay and never a substitute for `goal_status`/`observe`. Topics: `controller` (info), `state` (observe/sense state), `frame` (control inputs), `navigation`, `scan`, `goal` (goal view), `action` (other game requests with `ok/error`). Dashboard consumers: `GET /state` snapshot, `GET /events` SSE (`snapshot|update|producers`). Any process may push lines to `/ingest`; the dashboard never sends game or controller requests.

## Internal mod protocol

All requests use existing bounded JSON-line transport; game thread executes them. Public tools: [schemas](../src/controller/actions.mjs).

- `sense {session?,after?}` → `{state,terrain:{session,reset,cursor,more,clock,cells}}`. Max 128 cells/page. Rows: `[x,y,z,observedTick,hazard,relativeCollisionBoxes|null]`; boxes `[x1,y1,z1,x2,y2,z2]`; null invalidates. `clock`/timestamps are mod monotonic ms, not UTC. Reset discards old memory; drain `more` before movement. Air `[]` ≠ unknown. Nearby terrain sampling is camera-independent, range/occlusion bounded.
- `scan`: nearby awareness ≤8 blocks, distant 120×90° sight ≤64. Both require loaded sightlines. Pages target ≤12ms/128 rays/32768 cells; native calls can exceed budget. Cursor fixes origin/filter/view, expires after 30s, movement >2 or distant-view rotation >15°. Four cursors, ≤4096 results each. `more` continues enumeration; `incomplete` also flags unloaded/truncated data. Not a world snapshot; revalidate before interaction. Distant object sightings do not imply a traversable route.
- `control_begin {owner,session,epoch}`: owner 32-hex UUID; observed life session/control epoch; exclusive 500ms initial lease.
- `control_frame {owner,sequence,durationMs,yawDegrees,pitchDegrees,forward,jump,sprint?,focus?}`: increasing sequence, duration 1–500ms; atomic inputs/aim. Optional focus `{x,y,z}` only prioritizes a nearby visible sample. Never bypasses sightlines. Expired/revoked owners cannot resume.
- `control_step {control_frame fields,session?,after?}`: applies one guarded frame and returns the same state/terrain batch as `sense`. This keeps low-FPS clients to one game-thread request per lease refresh. A frame received before lease expiry remains valid if a render tick delays processing; cancelled or late frames cannot revive control.
- `control_end {owner}`: releases only that owner. `stop` revokes globally. Manual movement, damage, critical health/oxygen, menu/death/world exit/F8 revoke control. Primitive actions refused while leased.
- `block_action_begin {id,kind:dig|place,target,slot,item,expectedState,face?}`: caller UUID (32 hex), native selection/inventory guards. Dig holds normal left-click; place calls native single-placement path once. Place requires a non-replaceable support and adjacent empty/dry destination; no specialized item-use. Node owns aiming, deadline and completion.
- `block_action_continue {id,sequence}` renews a working dig for ≤2000ms without releasing the button; increasing sequence, expiry terminal. `block_action_status {id}` never renews. Observe includes latest `blockAction`; one record, world-reset scoped. States `working|changed|failed|cancelled`; changed ≠ confirmed success. Only selected operation cell is observed while stationary/in reach/visible, ≤5s after change. Stop/danger release it.
- Block goals verify stable client-observed change (dig → air; place → destination changed + one item consumed in survival). Native prediction may still be corrected later; no server acknowledgement/causality guarantee. Dig drops/pickup are separate; no mutation retries or implicit terrain editing during navigation.
- Controller refreshes ≤500ms frames and renews before route planning; missing process/network/game ticks cannot authorize indefinite input. Frozen game threads enforce expiry on resumption.
