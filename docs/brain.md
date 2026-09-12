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
- A brain may return `wants`: code substrings every walk picks up when they lie within six blocks (loose sticks, stones, flints, dropped items, food where it grows), whatever the current job. The default brain always wants berries, edible mushrooms and wild honeycomb, sticks until it has ten, flint and loose stones until it has tools.
- Memory has two parts. **Notes** are the decisions the brain made about a world (home, chests, claimed spots): plain JSON the loop keeps on disk per world, player and brain (`<knowledge dir>/notes/`, written when they change and on stop) and hands back to `fresh(notes)` when the world is next entered. Everything else is transient and dies with the process. What was seen is never a note: that is `Knowledge`. Moving home is rewriting a note. The map mirrors what others should find: the default brain keeps a `Home` marker where its note says, once per home.
- Code: `src/brain/<name>.ts` default-exports `{ name, description, fresh(notes?), decide(reading, memory), notes?(memory), summary?(memory) }`; `src/runtime/brain.ts` owns the loop. `decide` is pure: one reading (`observe`, `inventory`, `environment`, the active goal, the brain's own goal that just finished, the events since the last decision, the player's own map markers, the nearest dry ground while swimming) and the brain's memory in, one decision out (`{ start, args, why }`, `{ act, why }`, `{ stop }`, `{ wait }`). `act` runs actions by hand; alongside a running goal only tools that talk (chat, map markers, memory) are accepted. `test/brain.test.ts` covers it without a game.

Later brains (roles) differ only in `decide`. Behavior sources: [getting-started](getting-started.md), [architecture](architecture.md), [bot API](bot-api-reference.md).

## Shape of a brain

Three tiers, each a list in order of concern, all re-derived from the reading every tick; nothing is queued or stored as a plan, so a change in the world reorders the work for free and nothing has to be repaired after a flight, a death or a restart:

- **Reflexes**: pressing conditions checked first (danger, a storm, hunger, night). A reflex may cut a running job short; a few jobs (a flight, a dig-in, a dig-out) are never cut.
- **Tasks**: wants, not steps. Each says when the kit or the notes show it done, what it waits on, and which goal reaches it; the first not done, not waiting and not set aside is the one worked on. A one-shot task stays done (a knife exists); a recurring one flips back (the pack is heavy again). A task with a place (home, a chest) travels there first.
- **Alongside**: what runs beside any job through tools that only talk: marking a find, a chat line, `wants` picked up on the way.

Each concern owns its predicate, the goal it starts, its say while that goal runs, and the bookkeeping when it ends; adding one is a file and a line in a list. The contract is `Concern` in `src/brain/default/concern.ts`; the default brain's parts live in `src/brain/default/{reflexes,tasks,alongside}/`, its ladder and lists in `src/brain/default.ts`.

## Default brain: cautious beginner

A new player who stays alive first and builds up slowly. Afraid of monsters
and of whatever just hit it, keeps its belly full, spends the night inside four walls,
marks copper it passes for later. Follows
[getting-started](getting-started.md) days 1–2 minus all pottery. It never
fights; it runs or hides.

### Jobs

| Job | Goal | When |
| --- | --- | --- |
| hide | `travel` away from the threat, or home / straight ahead; stopped once nothing has shown for 20 s and the scare is 16 blocks behind | Monster seen or heard near, or hurt by something unseen |
| recover | `retrieve_body` | A death marker is on the map, by day; before any of the kit |
| copper | `add_map_waypoint` Copper and a `chat` line, alongside whatever runs | A copper nugget sighted with no Copper marker within 32 blocks |
| dead | `respawn` | Dead with a respawn offered |
| swim | `look` and `move` with jump held | In deep water with no goal running |
| go_home | `travel` home | Storm or night, away from home |
| burrow | `burrow` | Night with no home: a pocket in a bank of earth when a block to seal it is carried, else a hole two blocks straight down where it stands, sealed with what it digs; never cut short by a threat |
| unburrow | `dig_area` on the mouth | Morning, dug in |
| wait | none | Storm at home, night at home, or dug in for the night |

Wants (what every walk stops for within six blocks): berries on a ripe bush, an edible mushroom and a wild hive always; loose sticks while short of ten; loose flint and stones while a tool head is wanted and nothing knappable is carried.
| eat | `forage` to half with two bites kept; `eat` alone when dug in with food | Satiety below 20% (or 40% with nothing carried); eats what is carried when hungry (in the burrow too, off an earth wall), keeps the rest, searches ever farther in one direction for more, and when starving stomachs a bite that costs a point of health |
| dirt | `harvest soil-` | No home and fewer than 28 dirt |
| shelter | `shelter` | Enough dirt (by day, or at night with nowhere else) |
| sticks | `gather stick` (loose sticks, then branchy leaves in reach) | Fewer than 10 sticks |
| stone | `gather looseflints` (loose flint, or a knappable loose stone picked up on the way) | A tool is missing and nothing knappable is carried |
| tools | `knap` a head from the flint or knappable stone carried, `craft_item` the tool of that material | Missing the knife, the axe or the shovel |
| grass | `harvest tallgrass` | Wants torches, no dry grass or cattail tops |
| torches | `craft_item torch` | Fewer than 2 torches |
| logs | `fell_tree` | Fewer than 8 logs |
| explore | `explore` | Fed, safe, daylight, kit done |

Order of concern, and the interrupt rule for a running job: danger (a hostile
near, or a hit), a storm, food in hand when hungry, a place that keeps scaring,
night (dig in, or go home), then the day-1 list, then exploring. A running job
is cut short only when the ladder itself would rather do one of the pressing
things above the list; a flight, a dig-out and a night dig-in are never cut
short by a threat. The list (`TASKS` in the brain) is a task tracker: each task says
when the kit shows it done, the order carries the dependencies (a tool needs a
stick and a head, dirt needs a shovel, a shelter needs dirt, torches need a home
to light), and the first task not done is the one worked on. `brain` status
shows every task as done, next, open or set aside. A failed job is set aside while the bot stays within 24
blocks of where it failed, for five minutes at most; the next job in the ladder
runs meanwhile, so a failure never leaves it standing about. Chests,
`store_items`/`take_items` and body pickup are not used yet: it carries everything.

### Tiny shelter

Not the full house: a one-door box 3 wide by 3 deep, walls 2 high, flat roof,
from dirt (23 blocks), door 1 wide and 2 high sealed with 2 blocks from
inside, one torch on the floor once shut. Built by day near where it stands;
the spot becomes home.
