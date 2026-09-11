export const fmt = v => v == null ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2))
  : Array.isArray(v) ? JSON.stringify(v) : typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k}: ${fmt(x)}`).join(' · ') : String(v);
export const time = at => at ? new Date(at).toLocaleTimeString([], { hour12: false }) : '—';
export const ago = (at, now) => { const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m ago`; };
export const elapsed = (from, to) => { const sec = Math.max(0, Math.round((to - from) / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`; };
export const code = c => typeof c === 'string' ? c.replace(/^game:/, '') : c;
export const point = p => p && p.x != null ? [p.x, p.y, p.z].map(v => v == null ? '?' : Math.round(v)).join(', ') : null;
const count = (n, what) => `${n}× ${what}`;
// What the goal is trying to accomplish, from its request arguments (see controller/actions).
const describe = {
  harvest: a => `${count(a.count, code(a.item))} from ${a.match}${a.tool ? ' with ' + a.tool.toLowerCase() : ''}`,
  fell_tree: a => `${count(a.count, 'logs')} with axe`,
  knap: a => `${code(a.output)}${a.material ? ' from ' + code(a.material) : ''}`,
  clayform: a => `${code(a.output)}${a.material ? ' from ' + code(a.material) : ''}`,
  craft_item: a => count(a.count, code(a.output)),
  build: a => a.preset ? `${a.preset.kind} of ${code(a.preset.item)} at ${point(a.preset.origin)}`
    : `${a.cells?.length ?? 0} blocks: ${[...new Set((a.cells ?? []).map(c => code(c.item)))].join(', ')}`,
  dig_area: a => a.box ? `box ${point(a.box.from)} → ${point(a.box.to)}${a.tool ? ' with ' + a.tool.toLowerCase() : ''}` : `${a.cells?.length ?? 0} cells`,
  travel: a => a.waypoint ? `to waypoint "${a.waypoint}"` : `to ${point(a)}`,
  explore: a => a.legs != null ? `${a.legs} legs${a.heading != null ? ' from heading ' + Math.round(a.heading) + '°' : ''}` : 'unmapped terrain',
  use_on_block: a => `${a.item === null ? 'empty hand' : a.item ? code(a.item) : 'held item'} on ${a.target}${a.sneak ? ' (sneak)' : ''}`,
  collect_item: a => `${code(a.expectedItem)} (${a.target})`,
  equip: a => a.item === null ? 'empty hand' : a.item ? code(a.item) : `${a.tool}${a.minTier ? ' tier ≥ ' + a.minTier : ''}`,
  dig_block: a => a.target, place_block: a => `${code(a.expectedItem)} on ${a.target}`,
  gather_sticks: a => count(a.count ?? 10, 'sticks'), move_to: a => `to ${point(a)}`,
  forage: a => a.count ? `${count(a.count, 'fresh food')} in reserve` : 'food for recovery',
  forage_travel: a => `${count(a.count, 'fresh food')}, then ${point(a)}`,
  eat: () => 'fresh food from inventory', collect_stick: () => 'one visible stick',
};
export const goalTitle = g => typeof g?.intent === 'string' && g.intent.trim() ? g.intent.trim()
  : g?.args && typeof g.args === 'object' && !g.args.truncated ? (describe[g.kind]?.(g.args) ?? fmt(g.args)) : '';
const detailKeys = ['target', 'cell', 'ground', 'item', 'food', 'recipe', 'reason', 'from', 'slot', 'face', 'operation', 'leg', 'hunger', 'reserve'];
export function phaseDetail(progress) {
  const p = progress ?? {};
  return detailKeys.filter(k => p[k] != null).map(k => {
    const v = p[k]; const text = k === 'cell' || k === 'target' && typeof v === 'object' ? point(v) : typeof v === 'string' ? code(v) : fmt(v);
    return k === 'target' || k === 'cell' ? text : `${k} ${text}`;
  }).join(' · ');
}
export const shownProgressKeys = new Set(['phase', ...detailKeys, 'match', 'clicks', 'count', 'gained', 'wanted', 'total', 'placed', 'dug', 'failed', 'legs', 'remaining', 'layer', 'kind', 'output', 'material', 'completed', 'step', 'steps', 'subgoal']);
// One-line completion summary per goal kind; null when the skill reports no comparable numbers.
export function completion(g) {
  const p = g.progress ?? {}, a = g.args ?? {};
  if (p.truncated) return null;
  if (g.kind === 'goal_script' && p.steps != null) return { current: p.completed ?? 0, max: p.steps, unit: 'goals' };
  if (p.gained != null && (p.count ?? p.wanted ?? a.count) != null) return { current: p.gained, max: p.count ?? p.wanted ?? a.count, unit: 'gained' };
  if (p.total != null) return { current: (p.placed ?? p.dug ?? 0) + (p.failed ?? 0), max: p.total, unit: p.placed != null ? 'placed' : 'dug', extra: p.failed ? `${p.failed} failed` : '' };
  if (p.legs != null && p.leg != null) return { current: p.leg, max: p.legs, unit: 'leg' };
  if (g.kind === 'clayform' && p.layer != null) return { current: p.layer, max: 16, unit: 'layer', extra: p.remaining != null ? `${p.remaining} voxels left` : '' };
  if (p.remaining != null) return { text: g.kind === 'travel' ? `${p.remaining} blocks to go` : `${p.remaining} voxels left${p.clicks != null ? ' · ' + p.clicks + ' clicks' : ''}` };
  return null;
}
export const stateClass = s => s === 'arrived' || s === 'completed' ? 'good' : s === 'blocked' || s === 'cancelled' || s === 'failed' ? 'bad' : '';
export function logDetail(e) {
  const d = e.data ?? {};
  if (e.topic === 'action') return `${d.action} ${d.ok ? '' : '✗ ' + (d.error ?? d.code ?? '')} ${JSON.stringify(d.args ?? {})}`;
  if (e.topic === 'goal') return `${goalTitle(d) || d.kind} ${d.state}${d.reason ? ' — ' + d.reason : ''}${d.progress?.subgoal?.kind ? ' · ' + d.progress.subgoal.kind : ''}${d.progress?.phase ? ' · ' + d.progress.phase : ''}`;
  return JSON.stringify(d);
}
export const logBad = e => e.data?.ok === false || ['blocked', 'cancelled', 'failed'].includes(e.data?.state);
