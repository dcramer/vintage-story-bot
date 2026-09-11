import { list, now, isLive, positionHistory } from './store.js';
import { ago, elapsed, goalTitle, phaseDetail, point, stateClass } from './format.js';
import { Seen, Tag } from './ui.jsx';
import { WorldMap } from './Map.jsx';

const pct = vital => vital?.max > 0 ? Math.max(0, Math.min(1, vital.current / vital.max)) : null;
const finitePoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.z);
const latestState = bot => bot.topics.state?.data ?? {};
const latestGoal = bot => bot.topics.goal?.data;
const latestNav = bot => bot.topics.navigation?.data;
const percent = value => value == null ? '—' : `${Math.round(value * 100)}%`;

function attentionFor(bot) {
  const state = latestState(bot), goal = latestGoal(bot), reasons = [];
  if (!isLive(bot)) reasons.push(`silent ${ago(bot.seenAt, now.value)}`);
  if (state.alive === false || state.life?.state === 'dead') reasons.push('dead');
  for (const alert of state.life?.alerts ?? []) reasons.push(alert.replace(/_/g, ' '));
  if (pct(state.vitals?.health) != null && pct(state.vitals.health) <= .3) reasons.push('critical health');
  if (pct(state.vitals?.hunger) != null && pct(state.vitals.hunger) <= .2 && !reasons.some(reason => reason.includes('satiety'))) reasons.push('low food');
  if (goal && ['blocked', 'cancelled', 'failed'].includes(goal.state)) reasons.push(`${goal.state} goal`);
  return [...new Set(reasons)];
}

function goalTarget(bot) {
  const goal = latestGoal(bot), args = goal?.args, nav = latestNav(bot);
  if (finitePoint(args)) return args;
  return finitePoint(nav?.target) ? nav.target : null;
}

function pathDistance(rows) {
  let distance = 0;
  for (let i = 1; i < rows.length; i++) if ((rows[i].dimension ?? 0) === (rows[i - 1].dimension ?? 0))
    distance += Math.hypot(rows[i].x - rows[i - 1].x, rows[i].z - rows[i - 1].z);
  return distance;
}

function Metric({ label, value, note, tone = '' }) {
  return <div class={`metric ${tone}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

function MissionBoard({ bots }) {
  const ordered = bots.slice().sort((a, b) => Number(!!latestGoal(b)?.active) - Number(!!latestGoal(a)?.active) || b.seenAt - a.seenAt);
  return <section class="mission-board panel">
    <div class="panel-title"><div><span class="eyebrow">Mission queue</span><h2>Current objectives</h2></div><span class="panel-count">{ordered.filter(bot => latestGoal(bot)?.active).length} active</span></div>
    <div class="mission-list">{ordered.length ? ordered.map(bot => {
      const goal = latestGoal(bot), progress = goal?.progress ?? {}, nav = latestNav(bot), target = goalTarget(bot);
      return <a href={`/bots/${encodeURIComponent(bot.id)}`} class="mission-row" key={bot.id}>
        <span class={`agent-swatch agent-${bots.indexOf(bot) % 6}`} /><div class="mission-copy"><div><b>{bot.id}</b><span>{goal?.kind?.replace(/_/g, ' ') ?? 'standing by'}</span></div>
          <strong>{goal ? goalTitle(goal) || progress.phase?.replace(/_/g, ' ') || 'Objective assigned' : 'No mission assigned'}</strong>
          <small>{progress.phase ? progress.phase.replace(/_/g, ' ') + (phaseDetail(progress) ? ` · ${phaseDetail(progress)}` : '') : target ? `target ${point(target)}` : nav?.state ?? 'waiting for orders'}</small></div>
        <div class="mission-state"><Tag cls={stateClass(goal?.state)}>{goal?.state ?? 'idle'}</Tag>{goal?.startedAt && <small>{elapsed(goal.startedAt, goal.finishedAt ?? now.value)}</small>}</div>
      </a>;
    }) : <div class="panel-empty">No missions have reported yet.</div>}</div>
  </section>;
}

function Attention({ bots }) {
  const rows = bots.map(bot => ({ bot, reasons: attentionFor(bot) })).filter(row => row.reasons.length);
  return <section class="attention panel">
    <div class="panel-title"><div><span class="eyebrow">Exception queue</span><h2>Needs attention</h2></div><span class={`panel-count ${rows.length ? 'danger' : ''}`}>{rows.length}</span></div>
    {rows.length ? <div class="attention-list">{rows.map(({ bot, reasons }) => <a href={`/bots/${encodeURIComponent(bot.id)}`} key={bot.id}><span class="attention-mark">!</span><span><b>{bot.id}</b><small>{reasons.join(' · ')}</small></span><span class="row-arrow">→</span></a>)}</div>
      : <div class="nominal"><span>✓</span><div><b>All systems nominal</b><small>No stale, critical, or failed Seraphs.</small></div></div>}
  </section>;
}

function FleetRoster({ bots }) {
  return <section class="roster panel wide">
    <div class="panel-title"><div><span class="eyebrow">Fleet posture</span><h2>Seraph state</h2></div><span class="panel-count">{bots.length} known</span></div>
    <div class="roster-scroll"><table><thead><tr><th>Seraph</th><th>Status</th><th>Mission</th><th>Position</th><th>Health</th><th>Hunger</th><th>Recent path</th><th>Last contact</th></tr></thead>
      <tbody>{bots.map((bot, index) => { const state = latestState(bot), goal = latestGoal(bot), trail = positionHistory(bot), attention = attentionFor(bot);
        return <tr key={bot.id}><td><a class="roster-name" href={`/bots/${encodeURIComponent(bot.id)}`}><i class={`agent-${index % 6}`} />{bot.id}</a></td>
          <td><span class={`roster-status ${attention.length ? 'attention' : isLive(bot) ? 'live' : ''}`}>{attention[0] ?? (goal?.active ? 'working' : 'standby')}</span></td>
          <td><b>{goal?.kind?.replace(/_/g, ' ') ?? '—'}</b><small>{goal?.progress?.phase?.replace(/_/g, ' ') ?? goal?.state ?? ''}</small></td>
          <td class="mono">{point(state.position) ?? '—'}</td><td>{percent(pct(state.vitals?.health))}</td><td>{percent(pct(state.vitals?.hunger))}</td>
          <td>{Math.round(pathDistance(trail))} blocks</td><td><Seen bot={bot} /></td></tr>; })}</tbody></table></div>
  </section>;
}

export function Fleet() {
  const bots = list.value, live = bots.filter(isLive), active = bots.filter(bot => latestGoal(bot)?.active), attention = bots.filter(bot => attentionFor(bot).length);
  const average = key => { const values = live.map(bot => pct(latestState(bot).vitals?.[key])).filter(value => value != null); return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; };
  const tracked = bots.reduce((sum, bot) => sum + pathDistance(positionHistory(bot)), 0);
  if (!bots.length) return <main class="mission-control"><div class="empty-state"><span class="radar-empty" /><h2>Waiting for Seraph telemetry</h2><p>The mission map will populate when the first bot reports.</p></div></main>;
  return <main class="mission-control">
    <div class="mission-heading"><div><span class="eyebrow">Live world operations</span><h2>Mission control</h2></div><div class="heading-note"><span class={attention.length ? 'signal-warn' : 'signal-live'} />{attention.length ? `${attention.length} need attention` : 'fleet nominal'}<small>updated continuously</small></div></div>
    <div class="metrics">
      <Metric label="Connected" value={`${live.length}/${bots.length}`} note="reporting now" tone={live.length === bots.length ? 'good' : 'warn'} />
      <Metric label="Missions" value={active.length} note={active.length === 1 ? 'objective in motion' : 'objectives in motion'} />
      <Metric label="Fleet health" value={percent(average('health'))} note="live average" tone={average('health') != null && average('health') <= .3 ? 'bad' : ''} />
      <Metric label="Food reserve" value={percent(average('hunger'))} note="live average" tone={average('hunger') != null && average('hunger') <= .2 ? 'bad' : ''} />
      <Metric label="Mapped movement" value={tracked >= 1000 ? `${(tracked / 1000).toFixed(1)}k` : Math.round(tracked)} note="blocks in retained trails" />
    </div>
    <section class="map-panel panel">
      <div class="panel-title map-title"><div><span class="eyebrow">Seen by the fleet</span><h2>World map</h2></div><div class="map-legend">{bots.map((bot, index) => <span key={bot.id}><i class={`agent-${index % 6}`} />{bot.id}</span>)}</div></div>
      <WorldMap bots={bots} />
      <div class="map-footer"><span>Actual Vintage Story World Map capture</span><span>Choose a Seraph's explored view</span><span>Solid: recent path</span><span>Dashed: objective</span></div>
    </section>
    <div class="command-rail"><Attention bots={bots} /><MissionBoard bots={bots} /></div>
    <FleetRoster bots={bots} />
  </main>;
}
