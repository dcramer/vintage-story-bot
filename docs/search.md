# Finding things

How a goal looks for something (`src/support/search.ts`, composed by every "find X" goal) and how the food search on top of it (`src/support/survival.ts`, the `forage` goal) is meant to behave. Perception limits: [navigation](navigation.md); the brain's part: [brain](brain.md).

## Principles

- **A search is what a player does**: take what is in reach, walk to what is in view, go back for what was seen before, and with nothing known head somewhere new and keep looking on the way. Nothing is found by asking the world.
- **Evidence over hope.** A lead (a remembered thing worth walking to) carries what happened when the bot went for it. One that could not be reached from here is not tried again from here, and its patch (things within 8 blocks and 3 of height) shares its fate: an unreachable ledge is never retried block by block.
- **Known before unknown, with travel and yield weighed together.** Ordinary leads are ordered by distance plus three blocks per block of height plus a penalty per failed attempt; food also weighs expected handbook satiety, taking effort, sighting age and harmful bites; a walk is spent on the cheapest lead that has not defeated the bot.
- **Range in a line, far.** With no lead, the search heads for a frontier 160 blocks off in the least-walked direction, ranked against observed places of the kind the thing grows in ([habitat](../src/support/habitat.ts)). Turning back costs extra so a search keeps its line, and the frontier is shared per kind of thing across goals: a search restarted after a flight, a night or a new goal carries on the same way. A leg that cannot be walked costs that direction, not the search.
- **Evidence is shared and outlives the goal.** An approach that got nowhere marks the lead's area failed in the places memory every goal reads; an area failed twice holds no leads for twenty minutes, whatever the goal, and each failure puts the leads there farther down the order. A patch of berries up a cliff is left behind in a minute, not circled until dark, and not circled again by the next goal either.
- **A hole ends the search.** A walk that finds no route at all from a spot with hardly any ground to reach means the body is in a hole; the goal ends with `pit` at once, as `travel` does, and the brain digs out.
- **Bounded and honest.** Every step reports whether it was productive: something taken, a new lead seen, or ground covered. A stretch of unproductive steps ends the goal with `none_found` rather than running to its deadline, so the brain can decide what the emptiness means (carry on the same way later, dig in, do other work). Nearby scans record search effort separately from failed walks; absence of food never makes terrain impassable. Search effort is scoped by kind and expires after twenty minutes. It is a viewpoint record, not proof that unseen ground is empty.
- **The pack, not the map, says when to stop.** Food is eaten only to the target satiety and a reserve is kept; a walk pauses when what is carried should be eaten, and picking things up in passing stops when food is short, so a hungry search spends its minutes on food.

## The loop, one step

1. **In reach** (surroundings, 8 blocks, all around): take the best wanted thing that is ready; one that cannot be taken is set aside for two minutes.
2. **In view** (the forward cone, once per viewpoint; a full turn when it shows nothing): read the pages of what came into view, then **memory** within the goal's range (256 blocks for food).
3. **A lead**: walk to a standing cell beside it (three nearest cells with a full route, cheapest first), else a short exploration leg toward it with a wider detour when it is well above or below. Arriving beside a remembered thing that is not there forgets it. A leg that got nowhere sets the patch aside and tries one leaf clearing.
4. **No lead**: choose or keep the frontier and walk a leg toward it, looking on the way; a stuck leg turns the heading, a second one on the same spot cuts through leaves.

Every step returns `taken`, `approached` or `ranged`, and counts as productive when something was taken, a new wanted thing came into view, or the body moved more than a few blocks.

## The food search

`forage` runs the loop with: wanted = anything whose handbook page says it yields something edible now (`foodYield`), ready = harvestable from where the body stands, take = harvest and pick up, habitats = those appropriate to the requested block codes, and a pause whenever the pack holds something that should be eaten. While ranging, it pauses every 24 blocks to inspect another viewpoint and redirects after 96 blocks without a wanted lead. Walking and new leads do not renew the harvest budget: 384 blocks or six minutes without a verified harvest ends with `none_found`, including the exhausted budget in the result. These are work limits, not biome knowledge; only observed terrain and handbook facts guide the search. It ends when satiety reaches `until` with `keep` satiety worth in the pack, or with `none_found` after `SEARCH_PATIENCE` unproductive steps, recording search effort where it gave up and dropping the frontier so the next search heads elsewhere. Starving, it stomachs a bite that costs a point of health. A predator stops the search where it stands: leads it guards are set aside and the frontier it stands toward is dropped.
