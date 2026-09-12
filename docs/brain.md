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
- A goal started by an adapter always wins: the brain waits until it is over and never cancels it. Its own goals it interrupts only for danger, storms and hunger.
- Every brain gets respawn for free: dead with a respawn available means respawn, then carry on.
- Code: `src/brain/<name>.ts` default-exports `{ name, description, fresh(), decide(reading, memory), summary?(memory) }`; `src/runtime/brain.ts` owns the loop. `decide` is pure: one reading (`observe`, `inventory`, `environment`, the active goal, the brain's own goal that just finished) and the brain's memory in, one decision out (`{ start, args, why }`, `{ stop }`, `{ wait }`). `test/brain.test.ts` covers it without a game.

Later brains (roles) differ only in `decide`. Behavior sources: [getting-started](getting-started.md), [architecture](architecture.md), [bot API](bot-api-reference.md).

## Default brain: cautious beginner

A new player who stays alive first and builds up slowly. Afraid of monsters,
keeps its belly full, spends the night inside four walls. Follows
[getting-started](getting-started.md) days 1–2 minus all pottery. It never
fights; it runs or hides.

### Jobs

| Job | Goal | When |
| --- | --- | --- |
| hide | `travel` away from the threat | Monster seen or heard near |
| go_home | `travel` home | Storm or night, away from home |
| wait | none | Storm at home, night with nowhere to go, or a job cooling down |
| eat | `eat`, else `forage` | Satiety below 20% |
| dirt | `harvest soil-` | No home and fewer than 28 dirt |
| shelter | `build` walls in chunks, `travel` in, `build` the door, place a torch | Enough dirt (by day, or at night with nowhere else) |
| sticks | `gather_sticks` | Fewer than 10 sticks |
| stone | `harvest loosestone` | No knife or axe and nothing knappable |
| tools | `knap` a flint blade, `craft_item` the tool | Missing the knife or the axe |
| grass | `harvest tallgrass` | Wants torches, no dry grass or cattail tops |
| torches | `craft_item torch` | Fewer than 2 torches |
| logs | `fell_tree` | Fewer than 8 logs |
| explore | `explore` | Fed, safe, daylight, kit done |

Order of concern: danger, storm, hunger, night, shelter, then the kit in that
order, then exploring. A failed job is left alone for ten minutes. Chests,
`store`/`take` and body pickup are not used yet: it carries everything.

### Tiny shelter

Not the full house: a one-door box 3 wide by 3 deep, walls 2 high, flat roof,
from dirt (23 blocks), door 1 wide and 2 high sealed with 2 blocks from
inside, one torch on the floor once shut. Built by day near where it stands;
the spot becomes home.
