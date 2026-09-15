// Expected wall-clock time for one successful run of each goal, as a competent
// survival player does it: not a speedrunner, not dawdling. `scripts/bench.ts`
// compares logged bot runs against these and flags what is slow or failing,
// so a flag means "a player would be done by now", not "slower than the bot's
// own median". Pace assumptions: walking ~4 blocks/s, an aimed click ~2s, a
// container or grid dialog ~5-10s, soil ~2s a cell with a shovel, wood and
// stone longer with the right tool. Count-scaled goals (build, gather,
// harvest, dig_area, explore, travel) are judged at the sizes the brain
// typically issues. The bot usually trails a player (planning looks, software
// renderer); the ratio says by how much. A null expectation means the
// duration is the request itself (wait) or the sum of composed steps
// (goal_script): judging those against one number would mislead, so the
// report shows their runs unflagged.

export type Benchmark = { expectedMs: number | null; note: string };

const s = (seconds: number) => seconds * 1000;

export const BENCHMARKS: Record<string, Benchmark> = {
  build: { expectedMs: s(60), note: 'a dozen cells at one aimed placement per 2s plus approach' },
  burrow: { expectedMs: s(240), note: 'dig a hole and seal it by hand' },
  clayform: { expectedMs: s(300), note: 'place clay, pick the recipe, shape the layers' },
  collect_item: { expectedMs: s(30), note: 'walk to a nearby drop and pick it up' },
  cook: { expectedMs: s(300), note: 'fuel, pot, wait out the cooking, take the meal' },
  craft_item: { expectedMs: s(15), note: 'one grid recipe: open, place, take' },
  dig_area: { expectedMs: s(60), note: 'about ten soil cells with a shovel plus moving between them' },
  dig_block: { expectedMs: s(15), note: 'aim, break one block, pick up' },
  dig_out: { expectedMs: s(300), note: 'cut stair-steps out of a pit' },
  eat: { expectedMs: s(15), note: 'select food and eat to half' },
  enter_shelter: { expectedMs: s(120), note: 'reach the door, seal two cells, light a torch' },
  equip: { expectedMs: s(15), note: 'a few slot moves' },
  explore: { expectedMs: s(60), note: 'one leg: walk ~40 blocks and sweep the view' },
  farm: { expectedMs: s(600), note: 'a small fenced plot: till, plant, water' },
  fell_tree: { expectedMs: s(180), note: 'chop, gather logs, clear leaves' },
  firepit: { expectedMs: s(180), note: 'dig, grass, sticks, light' },
  forage: { expectedMs: s(480), note: 'wander and pick to half bar plus a buffer' },
  forage_travel: { expectedMs: s(300), note: 'a travel leg with forage stops' },
  gather: { expectedMs: s(180), note: 'ten loose things, scattered' },
  goal_script: { expectedMs: null, note: 'composed: duration is the sum of its steps' },
  harvest: { expectedMs: s(300), note: 'about fifteen cuts walking between plants with a knife' },
  house: { expectedMs: s(900), note: 'one construction phase of the 8x5 house' },
  inspect_container: { expectedMs: s(15), note: 'open, read, close' },
  knap: { expectedMs: s(90), note: 'flint in reach: surface, recipe, ~25 voxels at a click each' },
  light_shelter: { expectedMs: s(30), note: 'place and light two torches' },
  look_around: { expectedMs: s(60), note: 'one sweep of the view' },
  move_to: { expectedMs: s(30), note: 'a short walk under 40 blocks' },
  place_block: { expectedMs: s(15), note: 'aim, click, verify one placement' },
  plant: { expectedMs: s(120), note: 'soil, seeds and water for a few crops' },
  retrieve_body: { expectedMs: s(600), note: 'walk back and pick up' },
  shelter: { expectedMs: s(900), note: 'raise the starter shelter' },
  shelter_access: { expectedMs: s(30), note: 'open the door, cross, close' },
  store_items: { expectedMs: s(60), note: 'shuffle a pack into a chest' },
  take_items: { expectedMs: s(60), note: 'take a short list from a chest' },
  travel: { expectedMs: s(120), note: 'a few hundred blocks on foot with looks' },
  use_block: { expectedMs: s(30), note: 'aim and work one interaction' },
  wait: { expectedMs: null, note: 'duration is the request' },
};

export type Run = { kind: string; ms: number; ok: boolean; reason?: string };
export type Verdict = {
  kind: string;
  runs: number;
  ok: number;
  p50Ms: number | null;
  avgMs: number | null;
  maxMs: number | null;
  expectedMs: number | null;
  ratio: number | null;
  flags: string[];
  topReasons: [string, number][];
};

// Median-first comparison: one catastrophic run should not condemn a goal,
// but a typical run at twice the human reference, or losing half the runs,
// does.
export function summarizeRuns(benchmarks: Record<string, Benchmark>, runs: Run[]): Verdict[] {
  const byKind = new Map<string, Run[]>();
  for (const run of runs) {
    if (!byKind.has(run.kind)) byKind.set(run.kind, []);
    byKind.get(run.kind)!.push(run);
  }
  const kinds = new Set([...Object.keys(benchmarks), ...byKind.keys()]);
  return [...kinds].sort().map(kind => {
    const rs = byKind.get(kind) ?? [];
    const expectedMs = benchmarks[kind]?.expectedMs ?? null;
    if (!rs.length) return { kind, runs: 0, ok: 0, p50Ms: null, avgMs: null, maxMs: null, expectedMs, ratio: null, flags: ['no-runs'], topReasons: [] };
    const ms = rs.map(r => r.ms).sort((a, b) => a - b);
    const p50Ms = ms[Math.floor(ms.length / 2)];
    const avgMs = Math.round(ms.reduce((a, b) => a + b, 0) / ms.length);
    const maxMs = ms[ms.length - 1];
    const ok = rs.filter(r => r.ok).length;
    const ratio = expectedMs ? +(p50Ms / expectedMs).toFixed(2) : null;
    const flags: string[] = [];
    if (rs.length >= 2 && ok / rs.length < 0.5) flags.push('failing');
    if (ratio !== null && rs.length >= 2 && ratio > 2) flags.push('slow');
    if (!(kind in benchmarks)) flags.push('unbenchmarked');
    const reasons = new Map<string, number>();
    for (const r of rs.filter(r => !r.ok)) reasons.set(r.reason ?? 'unknown', (reasons.get(r.reason ?? 'unknown') ?? 0) + 1);
    const topReasons = [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 3) as [string, number][];
    return { kind, runs: rs.length, ok, p50Ms, avgMs, maxMs, expectedMs, ratio, flags, topReasons };
  });
}
