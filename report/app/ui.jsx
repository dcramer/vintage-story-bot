import { now, isLive } from './store.js';
import { ago, fmt, time, stateClass, goalTitle, phaseDetail, completion, elapsed, logDetail, logBad } from './format.js';

export const Tag = ({ cls = '', children }) => <span class={cls}>{children}</span>;
export const Pill = ({ cls = '', children }) => <span class={`pill ${cls}`}>{children}</span>;
export function Seen({ bot }) { return <Pill cls={isLive(bot) ? 'on' : 'off'}>{ago(bot.seenAt, now.value)}</Pill>; }
export function Meter({ name, vital, lowAt }) {
  const pct = vital?.max ? Math.max(0, Math.min(1, vital.current / vital.max)) : null;
  const level = pct == null ? '' : pct <= lowAt ? 'bad' : pct <= lowAt + .2 ? 'warn' : '';
  return <div class={`meter ${level}`}><span>{name}</span><div class="bar"><i style={{ width: `${(pct ?? 0) * 100}%` }} /></div>
    <span class="value">{pct == null ? 'unknown' : `${vital.current.toFixed(1)} / ${vital.max.toFixed(0)}`}</span></div>;
}
export function Dl({ rows }) {
  return <dl>{rows.filter(([, v]) => v != null).map(([k, v]) => <><dt key={k + ':k'}>{k}</dt><dd key={k}>{fmt(v)}</dd></>)}</dl>;
}
export function StateTags({ s, n }) {
  const tags = [];
  if (s.alive != null || s.life) tags.push([s.life?.state ?? (s.alive ? 'alive' : 'dead'), s.alive ? 'good' : 'bad']);
  if (s.controlReady != null) tags.push([s.controlReady ? 'control ready' : 'no control', s.controlReady ? 'good' : 'bad']);
  if (s.paused) tags.push(['paused', 'bad']);
  for (const a of s.life?.alerts ?? []) tags.push([a, 'bad']);
  if (s.condition?.onFire) tags.push(['on fire', 'bad']);
  if (s.condition?.temporalStorm?.phase && s.condition.temporalStorm.phase !== 'none') tags.push(['storm ' + s.condition.temporalStorm.phase, 'warn']);
  if (s.motion?.swimming) tags.push(['swimming']); if (s.motion?.sprinting) tags.push(['sprinting']);
  if (s.motion && !s.motion.onGround) tags.push(['airborne']); if (s.mounted) tags.push(['mounted']);
  if (n?.evading) tags.push(['evading', 'warn']);
  return <div class="tags">{tags.map(([text, cls]) => <Tag key={text} cls={cls}>{text}</Tag>)}</div>;
}
export function GoalLine({ g }) {
  if (!g) return <div class="goal"><span class="kind">no goal</span></div>;
  const p = g.progress ?? {}, subgoal = p.subgoal, detail = subgoal?.progress ?? p;
  const phase = detail.phase ? `${detail.phase.replace(/_/g, ' ')}${phaseDetail(detail) ? ' — ' + phaseDetail(detail) : ''}` : '';
  return <div class="goal">
    <div class="headline"><span class="kind">{g.intent ? 'Goal' : g.kind.replace(/_/g, ' ')}</span><b>{goalTitle(g)}</b>
      <span class="tags"><Tag cls={stateClass(g.state)}>{g.state}</Tag>{g.active && <Tag cls="good">active</Tag>}{g.startedAt && <Tag>{elapsed(g.startedAt, g.finishedAt ?? now.value)}</Tag>}</span></div>
    <div class="phase">{subgoal ? <><b>{subgoal.kind.replace(/_/g, ' ')}</b>{goalTitle(subgoal) ? ` — ${goalTitle(subgoal)}` : ''}{phase ? ` · ${phase}` : ''}</>
      : phase ? <b>{phase}</b> : g.reason ? <span class="muted">{g.reason}</span> : null}</div>
  </div>;
}
export function Completion({ g }) {
  const c = g && completion(g);
  if (!c) return null;
  if (c.text) return <div class="meter" style={{ gridTemplateColumns: '64px 1fr' }}><span>progress</span><span>{c.text}</span></div>;
  const pct = c.max ? Math.max(0, Math.min(1, c.current / c.max)) : 0;
  return <div class="meter"><span>{c.unit}</span><div class="bar"><i style={{ width: `${pct * 100}%` }} /></div><span class="value">{c.current} / {c.max}{c.extra ? ' · ' + c.extra : ''}</span></div>;
}
export function LogTable({ rows, withBot = false }) {
  return <div class="scroll"><table class="log"><thead><tr><th>Time</th>{withBot && <th>Bot</th>}<th>Topic</th><th>Detail</th></tr></thead>
    <tbody>{rows.length ? rows.map(e => <tr key={`${e.bot}|${e.at}|${e.topic}|${e.seq}`}><td>{time(e.at)}</td>{withBot && <td><a href={`/bots/${encodeURIComponent(e.bot)}`}>{e.bot}</a></td>}
      <td class={logBad(e) ? 'err' : ''}>{e.topic}</td><td>{logDetail(e)}</td></tr>) : <tr><td colSpan={withBot ? 4 : 3} class="muted">nothing logged</td></tr>}</tbody></table></div>;
}
// Stable keys for log rows: bot id, position within that bot's ring.
export const logRows = bot => bot.log.map((e, seq) => ({ ...e, bot: bot.id, seq }));
