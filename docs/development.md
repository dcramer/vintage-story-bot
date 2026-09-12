# Development

Client C# mod → loopback JSON/TCP → Node controller → stdio MCP/CLI.

- [Actions](../src/actions/) and [goals](../src/goals/): one file per public tool; MCP/CLI API contracts.
- [Architecture](architecture.md): module ownership and internal wire contract.
- [Game API reference](capabilities.md): installed sources and entry points.
- [Runtime](runtime.md): deployment, control, environment constraints.
- Game access on game thread; networking queues expiring requests. MCP stdout is protocol-only.
- Preserve `stop`, action deadlines, world-exit cleanup; synchronize schemas with API changes.
- C#: .NET 10, game 1.22.7; reference installed assemblies, never bundle them.
- JS/TS: Node 24+, ES modules, pnpm, node:test. New files are TypeScript with erasable syntax only (no enums, parameter properties or namespaces): Node strips types natively, there is no build; `pnpm typecheck` runs tsc without emitting.
- `pnpm bot [--brain default]` runs the Seraph process (`pnpm controller` is the same); `pnpm controller:dev` watches/restarts it and cancels active goals, never resumes them. No screenshot/UI dependencies in controller, navigation, goals, or MCP.

## Checks

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm test:mod
DOTNET_CLI_HOME="$PWD/.runtime/dotnet-home" .dotnet/dotnet build mod/VintageStoryAI.csproj -c Release -p:VintageStoryPath="$PWD/.runtime/linux-client"
pnpm mcp:smoke
```

Tests use temporary loopback mocks; require listener permission. Never target live game. C# checks compile selected `mod/` files into `test/mod/ModTests.csproj`.
Smoke performs live MCP discovery + observe only. Distinguish mock/build/singleplayer/multiplayer evidence in handoff, not a documentation log.
