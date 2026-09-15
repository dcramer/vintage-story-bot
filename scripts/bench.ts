// Goal benchmarks vs logged runs: which goals are slow or failing, and why.
// Reads session NDJSON (default: the newest under .runtime/logs), pairs
// goal_started/goal_finished by goal id, and compares each goal's runs
// against the human reference times in src/support/benchmarks.ts.
// Exit 0; a report, not a gate.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BENCHMARKS, summarizeRuns, type Run } from '../src/support/benchmarks.ts';

const usage = `Usage: bench [ndjson ...] [--json] [--expected]
  Compare logged goal runs against benchmarks. Default input is the newest
  session file under .runtime/logs. --json prints the verdicts as JSON.
  --expected prints the human reference table instead of reading logs.`;

const fmtMs = ms => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60000).toFixed(1)}m`);

function newestSession(): string | null {
  let best: { path: string; mtime: number } | null = null;
  let bots: string[] = [];
  try {
    bots = readdirSync('.runtime/logs');
  } catch {
    return null;
  }
  for (const bot of bots) {
    let files: string[] = [];
    try {
      files = readdirSync(join('.runtime/logs', bot));
    } catch {
      continue;
    }
    for (const file of files.filter(f => f.endsWith('.ndjson'))) {
      const path = join('.runtime/logs', bot, file);
      const mtime = statSync(path).mtimeMs;
      if (!best || mtime > best.mtime) best = { path, mtime };
    }
  }
  return best?.path ?? null;
}

export function readRuns(paths: string[]): { runs: Run[]; unfinished: number } {
  const started = new Map<string, number>();
  const runs: Run[] = [];
  for (const path of paths) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.startsWith('{')) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.scope !== 'event' || (e.event !== 'goal_started' && e.event !== 'goal_finished')) continue;
      if (e.event === 'goal_started') started.set(e.goal, Date.parse(e.at));
      else {
        const at = started.get(e.goal);
        if (at === undefined) continue;
        started.delete(e.goal);
        const reason = e.reason ?? e.outcome;
        runs.push({ kind: e.kind, ms: Date.parse(e.at) - at, ok: e.ok === true, ...(reason === undefined ? {} : { reason }) });
      }
    }
  }
  return { runs, unfinished: started.size };
}

function report(paths: string[], json: boolean): string {
  const { runs, unfinished } = readRuns(paths);
  const verdicts = summarizeRuns(BENCHMARKS, runs);
  if (json) return JSON.stringify({ paths, unfinished, verdicts }, null, 2);
  const out: string[] = [`sessions: ${paths.join(', ')}`, `runs: ${runs.length} (${unfinished} unfinished)`, ''];
  const cell = (v: string, w: number) => v.padEnd(w);
  out.push(`${cell('kind', 16)}${cell('n', 5)}${cell('ok%', 6)}${cell('p50', 7)}${cell('avg', 7)}${cell('max', 7)}${cell('expected', 10)}${cell('x', 6)}flags`);
  for (const v of verdicts.filter(v => v.runs > 0)) {
    const reasons = v.topReasons.map(([r, n]) => `${r}${n > 1 ? `x${n}` : ''}`).join(' ');
    out.push(
      `${cell(v.kind, 16)}${cell(String(v.runs), 5)}${cell(`${Math.round((100 * v.ok) / v.runs)}%`, 6)}` +
        `${cell(fmtMs(v.p50Ms!), 7)}${cell(fmtMs(v.avgMs!), 7)}${cell(fmtMs(v.maxMs!), 7)}` +
        `${cell(v.expectedMs === null ? '-' : fmtMs(v.expectedMs), 10)}${cell(v.ratio === null ? '-' : String(v.ratio), 6)}` +
        `${v.flags.join(',')}${reasons ? `  ${reasons}` : ''}`,
    );
  }
  const flagged = verdicts.filter(v => v.flags.some(f => f === 'failing' || f === 'slow'));
  const noruns = verdicts.filter(v => v.flags.includes('no-runs'));
  out.push('');
  if (!flagged.length) out.push('findings: nothing slow or failing');
  else {
    out.push('findings:');
    for (const v of flagged) out.push(`- ${v.kind} ${v.flags.join('+')} (${v.ok}/${v.runs} ok, p50 ${fmtMs(v.p50Ms!)})`);
  }
  if (noruns.length) out.push(`no runs: ${noruns.map(v => v.kind).join(', ')}`);
  return out.join('\n');
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    process.exit(0);
  }
  const json = args.includes('--json');
  if (args.includes('--expected')) {
    for (const [kind, b] of Object.entries(BENCHMARKS).sort(([a], [c]) => (a < c ? -1 : 1)))
      console.log(`${kind.padEnd(16)}${b.expectedMs === null ? '-' : fmtMs(b.expectedMs).padEnd(7)}${b.note}`);
    process.exit(0);
  }
  const paths = args.filter(a => a !== '--json');
  if (!paths.length) {
    const latest = newestSession();
    if (!latest) {
      console.error('no session ndjson under .runtime/logs');
      process.exit(1);
    }
    paths.push(latest);
  }
  console.log(report(paths, json));
}
