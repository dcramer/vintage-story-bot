# Diggy Smalls

Vintage Story bot: client C# mod → Node controller → MCP/CLI.

## Working baseline

- Read [Conventions](docs/conventions.md) first, then the relevant references below.
- Establish the intended outcome; inspect existing code, callers, and contracts before editing. Resolve routine choices from repository evidence; ask only when missing information materially changes the outcome or risk.
- Make the smallest complete fix at the owning layer. Reuse existing paths; avoid speculative abstractions, unrelated cleanup, and workarounds that hide the cause.
- Check the working tree before edits. Preserve unrelated changes; never revert or overwrite work you did not make.
- Carry authorized work through implementation and verification. If blocked, finish independent work and report the concrete blocker.
- Work directly on `main`; do not create branches or pull requests.
- After each implemented and verified piece of functionality, commit only its changes, push to `main`, and pull/rebase to stay synchronized with collaborators. If the remote advances before a push, pull/rebase and retry; preserve unrelated working-tree changes.
- Tests: do not write tests unless covering a critical regression. Prefer live gameplay verification and builds; no routine feature, refactor, or speculative tests.
- Verify the requested outcome, not just command success. In the handoff, state what changed, verification performed, and any remaining uncertainty; distinguish build/mock evidence from live gameplay.

## References

- [Conventions](docs/conventions.md) — read first; repo-wide writing, versioning, and documentation rules.
- [Development](docs/development.md) — read when changing code or running tests.
- [Architecture](docs/architecture.md) — read when changing module boundaries, RPC, control, or goal lifecycle.
- [Bot API reference](docs/bot-api-reference.md) — read when designing bot APIs, skills, or goals; Mineflayer analogues and design criteria.
- [Runtime](docs/runtime.md) — read before launching, deploying, configuring MCP, or controlling the bot.
- [Getting started](docs/getting-started.md) — read when defining or prioritizing goals; basics of playing the game: survival rules, house/kiln specs, and day 1–5 goal checklists.
- [Game API reference](docs/capabilities.md) — read when changing game integration or sensing; entry points, source material, and perception constraints.
