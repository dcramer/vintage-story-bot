# Benchmarks

Every goal has a documented human reference time: how long a competent
survival player takes to do the same thing. The bot logs every goal run with
start and finish timestamps (`goal_started` / `goal_finished` in the session
NDJSON under `.runtime/logs`), and `pnpm bench` compares the two so slow or
failing goals stand out mechanically instead of by feel.

- Reference table (the contract): [benchmarks.ts](../src/support/benchmarks.ts).
  Each entry carries its derivation in `note`. Null means the duration is the
  request itself (`wait`) or the sum of composed steps (`goal_script`).
- Report: `pnpm bench [ndjson ...]` (default: the newest session).
  `pnpm bench --expected` prints the reference table; `--json` prints verdicts
  for agents.
- A goal is flagged `slow` when its median run exceeds twice the reference
  over 2+ runs, `failing` when it loses half its runs. One bad run never
  condemns a goal.

Pace assumptions behind the references: walking ~4 blocks/s, an aimed click
~2s, a container or grid dialog ~5-10s, soil ~2s a cell with a shovel.
Count-scaled goals are judged at the sizes the brain typically issues. The bot
usually trails a player (planning looks, software renderer); the ratio says by
how much. Correct a reference by editing the table with a note saying why, the
same way any other contract changes.
