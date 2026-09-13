# Brain

A brain is what a bot does on its own. The bot process (`src/bot.ts`) runs
with a brain installed or with none: with none it stands still until an
adapter (CLI, script, agent) tells it what to do; with one, a core run loop
reads what the player knows every couple of seconds and answers with one
decision, carried out through the same public goals an agent would call.
One brain per bot, one goal at a time. `stop` interrupts everything; nothing
resumes on its own.

- Install at start: `pnpm bot --brain default` or `VINTAGE_STORY_BRAIN=default`.
- Switch while running: the `brain` action reads status, installs by name, or removes (`null`).
- The brain sees every goal, whoever started it. Danger (a hostile seen or heard, a hit) stops any goal; storms and hunger cut short only the brain's own; an adapter's goal is otherwise left to finish and never replaced.
- Nothing happens without the brain: respawning, swimming for shore, running from a hit and marking a find are its decisions. The loop wakes it when the controller notices something (`events`) as well as every couple of seconds.
- A brain may return `wants`: code substrings every walk picks up when they lie within six blocks (loose sticks, stones, flints, dropped items, food where it grows), whatever the current job. The default brain always wants berries, edible mushrooms and wild honeycomb, sticks while short of a few, flint and loose stones until it has tools.
- Memory has two parts. **Notes** are the decisions the brain made about a world (home, chests, claimed spots): plain JSON the loop keeps on disk per world, player and brain (`<knowledge dir>/notes/`, written when they change and on stop) and hands back to `fresh(notes)` when the world is next entered. Everything else is transient and dies with the process. What the eye saw of the world is never a note: that is `Knowledge`; what the bot itself last left in its own chest is, timestamped and re-verified when the chest is opened. Moving home is rewriting a note. The map mirrors what others should find: the default brain keeps a `Home` marker where its note says, once per home. Its notes are `home`, `dwelling` (the owned shelter door and sealing material), and `stash` (the chest's observed key and last-seen contents).
- Code: `src/brain/<name>.ts` default-exports `{ name, description, fresh(notes?), decide(reading, memory), notes?(memory), summary?(memory) }`; `src/runtime/brain.ts` owns the loop. `decide` is pure: one reading (`observe`, `inventory`, `environment`, the active goal, the brain's own goal that just finished, the events since the last decision, the player's own map markers, the nearest dry ground while swimming, the open dialogs while the controls are blocked) and the brain's memory in, one decision out (`{ start, args, why }`, `{ act, why }`, `{ stop }`, `{ wait }`). `act` runs actions by hand; alongside a running goal only tools that talk (chat, map markers, memory) are accepted. `test/brain.test.ts` covers it without a game.

Later brains (roles) differ only in `decide`. Behavior sources: [getting-started](getting-started.md), [architecture](architecture.md), [bot API](bot-api-reference.md).

## Shape of a brain

Three tiers, each a list in order of concern, all re-derived from the reading every tick; nothing is queued or stored as a plan, so a change in the world reorders the work for free and nothing has to be repaired after a flight, a death or a restart:

- **Reflexes**: pressing conditions checked first (danger, a storm, hunger, night). A reflex may cut a running job short; a few jobs (a flight, a dig-in, a dig-out) are never cut.
- **Tasks**: wants, not steps. Each says when the kit or the notes show it done, what it waits on, and which goal reaches it; the first not done, not waiting and not set aside is the one worked on. A one-shot task stays done (a knife exists); a recurring one flips back (the pack is heavy again). A task with a place (home, a chest) travels there first.
- **Alongside**: what runs beside any job through tools that only talk: marking a find, a chat line, `wants` picked up on the way.

Each concern owns its predicate, the goal it starts, its say while that goal runs, and the bookkeeping when it ends; adding one is a file and a line in a list. The contract is `Concern` in `src/brain/default/concern.ts`; the default brain's parts live in `src/brain/default/{reflexes,tasks,alongside}/`, its ladder and lists in `src/brain/default.ts`.

## Default brain: early survival

Follows the food, flint-tool, shelter, house and shared-material baseline in
[getting-started](getting-started.md). `TASKS` in the default brain owns task
order; each concern owns quantities, dependencies, and completion predicates.
Danger and survival conditions preempt ordinary work. Food recovery eats to
half, eating carried food before choosing the next preparation step; this recovery persists across goals and restarts. Successful cooking retains the cooking fallback while raw forage remains scarce. A separate daytime task builds a carried night reserve. Return time
accounts for distance from home, and dawn light never permits leaving before
05:00. At night only crafting with carried ingredients and shelter lighting
may replace the indoor wait; no sleeping.

New cattail roots are harvested only below 10% satiety after raw forage fails,
one at a time: uprooting destroys the plant. Carried roots and pending food
can still be cooked or retrieved above that threshold. A carried log ends
urgent fuel gathering; an empty firepit more than 48 blocks away is replaced
locally instead of spending the remaining health returning to it. Pending
food in an owned firepit is still retrieved. A failed route defers that cooking
record rather than forgetting it. Back within reach of the observed firepit,
check its output before preparing fuel; empty output resumes the pending cook.

The starter shelter is a freestanding, above-ground building, never an emergency burrow. Its natural floor stays at ground level. A 5×5 rammed-earth starter shelter follows the [template](getting-started.md#starter-shelter-template) while the full rammed-earth house
is built. A house site requires observed level ground and clear space; unknown
terrain is rejected. Construction keeps its chosen origin and phase across
interruptions and restarts. Existing shell blocks must match the material;
out-of-material results request another batch without abandoning the site.
The house becomes home only after its shell, lowered floor, entry and seal
are verified. These goals report client-observed changes, not server ACKs.

Notes include `home`, `starter` (the verified starter-template origin), `dwelling` (door and sealing material), `construction`,
`house`, `lightingDay`, `stash`, and additional `stores`. Being near home does not mean indoors:
the body must be inside and both door cells observed solid. Entry opens the
door, walks in, and seals it; departure opens it first. Failed re-entry falls
back to emergency cover. Carried sealing blocks and building materials stay
out of routine surplus deposits. Torches are lit through native firestarter
use. Installed torches are picked up and replaced one at a time after 05:00
each day; observed missing or extinguished torches invalidate the lighting
state immediately. Indoor lighting work does not open the shelter door.

The starter's 3×3 interior reserves six chest slots along the side walls,
one torch at the back center, and a clear center aisle to the front entrance.
Capacity comes before bulk materials: gather ten cattail tops, weave and equip
one hand basket, repeat for the second, then gather 24 tops for the first reed
chest. Place that chest in a reserved slot of the planned shelter and build
around it. Additional chests use the remaining side-wall slots.

Maintenance is recurring work, not a construction-complete flag. While at the
structure, each brain reading compares observed walls and roof with its recorded
template. Confirmed empty shell cells request rammed-earth repairs through
`build`; its normal block-delta verification applies. Recheck after each repair
and interruption. Unknown cells remain unknown, and different occupied blocks
are preserved. The entry/exit goals maintain the two-cell seal; lighting checks
maintain the interior torch. Craft repair blocks from carried materials first;
material gathering waits for safe daylight. Keep repairs ahead of ordinary
stockpiling, while immediate danger and hunger retain priority.

Planned entrance upgrade: two wattle gates stacked vertically, one gate per
1×1 cell of the two-high front opening, instead of a conventional door that can
break off. This is an advanced design target; the current implementation uses
removable sealing blocks. Before adopting gates, verify native placement,
orientation, independent opening/closing, passage, and persistence on the
multiplayer server. Entry and departure must operate both gates and verify the
result; maintenance must detect and replace either missing gate without
mistaking an intentionally open gate for structural damage.

Shared supplies have explicit stored targets and a map marker. Full storage
adds another chest, up to three; targets count all their observed contents. Container
counts are only the last opened observation; periodic inspection detects
teammates taking items. Gathering and deposits retain the bot's working kit.
Container transfers are verified through inventory deltas. `brain` status
shows the current concern, construction phase, and each task's readiness.
