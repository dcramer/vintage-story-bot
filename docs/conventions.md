# Repo conventions

- Audience: agents, not humans. Applies repo-wide: code, comments, docs, tests, tool schemas, and output.
- Minimize tokens without losing correctness, constraints, or discoverability. Prefer concise names/structures; no cryptic abbreviations or code minification.
- No tutorials, narrative history, repeated explanations, boilerplate, or speculative scaffolding.
- One source per fact. Link instead of duplicating; code/schemas define implemented behavior.
- Project/package/mod versions stay 0.1.0 until user requests otherwise. Detect bridge features, not release numbers.
- AGENTS.md indexes references with read conditions and owns testing policy. CLAUDE.md imports only AGENTS.md.
- Read this file first; load other references only when relevant. Keep references short and task-scoped.
- Prefer bounded structured data and deltas over prose, screenshots, or full-state dumps.
- Docs contain API contracts, reference material, and necessary operational constraints—not implementation inventories, changelogs, test-run results, progress, or next-step lists. Code/tests define implementation; report verification in handoff only.
- Update docs only when their reference information or contracts change, not after every implementation change.
