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
- A brain may return `wants`: code substrings every walk picks up when they lie within six blocks (loose sticks, stones, flints, dropped items), whatever the current job. The default brain wants sticks until it has ten, flint and loose stones until it has tools.
- Code: `src/brain/<name>.ts` default-exports `{ name, description, fresh(), decide(reading, memory), summary?(memory) }`; `src/runtime/brain.ts` owns the loop. `decide` is pure: one reading (`observe`, `inventory`, `environment`, the active goal, the brain's own goal that just finished, the events since the last decision, the player's own map markers, the nearest dry ground while swimming) and the brain's memory in, one decision out (`{ start, args, why }`, `{ act, why }`, `{ stop }`, `{ wait }`). `act` runs actions by hand; alongside a running goal only tools that talk (chat, map markers, memory) are accepted. `test/brain.test.ts` covers it without a game.

Later brains (roles) differ only in `decide`. Behavior sources: [getting-started](getting-started.md), [architecture](architecture.md), [bot API](bot-api-reference.md).

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
| wait | none | Storm at home, or night with nowhere to go |

Wants (what every walk stops for within six blocks): berries on a bush always; loose sticks while short of ten; loose flint and stones while a tool head is wanted and nothing knappable is carried.
| eat | `eat`, else `forage` | Satiety below 20% (or 40% with nothing carried); the pack any time, foraging by day |
| dirt | `harvest soil-` | No home and fewer than 28 dirt |
| shelter | `shelter` | Enough dirt (by day, or at night with nowhere else) |
| sticks | `gather stick` (loose sticks, then branchy leaves in reach) | Fewer than 10 sticks |
| stone | `harvest loosestone` | No knife or axe and nothing knappable |
| tools | `knap` a flint blade, `craft_item` the tool | Missing the knife or the axe |
| grass | `harvest tallgrass` | Wants torches, no dry grass or cattail tops |
| torches | `craft_item torch` | Fewer than 2 torches |
| logs | `fell_tree` | Fewer than 8 logs |
| explore | `explore` | Fed, safe, daylight, kit done |

Order of concern: danger, storm, hunger, night, then the day-1 list, then
exploring. The list (`TASKS` in the brain) is a task tracker: each task says
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
