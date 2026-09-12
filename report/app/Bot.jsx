import { bots, now } from './store.js';
import { ago, fmt, time, code, point, phaseDetail, shownProgressKeys, stateClass, goalTitle, runDuration, integer, blockCount, itemName } from './format.js';
import { Dl, LogTable, logRows } from './ui.jsx';
import { WorldMap } from './Map.jsx';

const words = value => String(value ?? '').replace(/_/g, ' ');
const percent = vital => vital?.max > 0 ? `${Math.round(vital.current / vital.max * 100)}%` : 'Unknown';
const shortReason = value => {
  const reason = String(value ?? '').replace(/^Error:\s*/, '').replace(/^Goal \d+\/\d+ \([^)]+\) failed:\s*/, '');
  if (/Gameplay interruption: life, controls or liquid/i.test(reason)) return 'The character could no longer continue this mission.';
  if (/Requested deadline reached/i.test(reason)) return 'The mission was interrupted.';
  return reason;
};

function Mission({ g }) {
  const p = g?.progress ?? {}, subgoal = p.subgoal, detail = subgoal?.progress ?? p;
  const title = goalTitle(g) || (g ? words(g.kind) : 'Standing by');
  const step = subgoal ? `${words(subgoal.kind)}${goalTitle(subgoal) ? ` — ${goalTitle(subgoal)}` : ''}` : null;
  const phase = detail.phase ? `${words(detail.phase)}${phaseDetail(detail) ? ` — ${phaseDetail(detail)}` : ''}` : null;
  return <section class="mission-brief">
    <div class="mission-copy"><span class="mission-label">{g?.active ? 'Current mission' : g ? 'Last mission' : 'Mission'}</span><h1>{title}</h1>
      {(step || phase) && <p class="mission-step">{step}{step && phase ? ' · ' : ''}{phase}</p>}
      {g?.reason && <p class="mission-reason">{shortReason(g.reason)}</p>}</div>
    <div class="mission-status">{p.steps && <><small>Step</small><b>{Math.min((p.completed ?? 0) + (subgoal ? 1 : 0), p.steps)} / {p.steps}</b></>}
      <span class={stateClass(g?.state)}>{words(g?.state ?? 'idle')}</span>{g?.startedAt && <time>{ago(g.finishedAt ?? g.startedAt, now.value)}</time>}</div>
  </section>;
}

function Live({ stream, state }) {
  const valid = typeof stream === 'string' && /^https?:\/\/[^/?#]+$/.test(stream), player = valid ? `${stream}/bot/` : null;
  return <section class="live-console">
    <div class="live-bar"><span>Live view</span>{player && <a href={player} target="_blank" rel="noopener">Open stream ↗</a>}</div>
    {player ? <div class="live-frame"><iframe src={player} title="Bot display" allow="autoplay; fullscreen" referrerpolicy="no-referrer" /></div>
      : <div class="panel-empty">Stream unavailable</div>}
    <div class="live-foot"><span>{point(state.position) ?? 'Position unknown'}</span><span>{state.orientation?.yawDegrees == null ? '' : `${state.orientation.yawDegrees.toFixed(0)}°`}</span></div>
  </section>;
}

// The Worker keeps the last goals per Seraph (latest state each) apart from the shared log ring.
function MissionHistory({ bot }) {
  const rows = (bot.goals ?? []).slice(-4).reverse();
  return <div class="mission-list">{rows.length ? rows.map(entry => {
    const g = entry.data ?? {}, p = g.progress?.subgoal?.progress ?? g.progress ?? {};
    return <div class="mission-row" key={g.id}>
      <div><strong>{goalTitle(g) || words(g.kind)}</strong><small>{p.phase ? words(p.phase) : shortReason(g.reason) || 'Mission update'}{phaseDetail(p) ? ` · ${phaseDetail(p)}` : ''}</small></div>
      <span class={stateClass(g.state)}>{words(g.state)}</span><time>{time(entry.at)}</time>
    </div>;
  }) : <div class="panel-empty compact">No missions reported</div>}</div>;
}

// The player's own markers on the game's world map, as the map screen lists them.
function MapMarkers({ bot }) {
  const rows = (bot.topics.waypoints?.data?.waypoints ?? []).slice(0, 12);
  return <div class="mission-list">{rows.length ? rows.map(marker => <div class="mission-row" key={marker.guid}>
    <div><strong>{marker.title || marker.icon}</strong><small>{marker.icon}{marker.pinned ? ' · pinned' : ''}</small></div>
    <span>{point(marker.position)}</span></div>)
    : <div class="panel-empty compact">No map markers reported</div>}</div>;
}

function GoalScript({ g }) {
  const source = g?.args?.goalScript;
  return source ? <pre class="goal-script"><code>{source}</code></pre>
    : <div class="panel-empty compact">{g?.kind === 'goal_script' ? 'Script was not reported for this run' : 'No composed goal script'}</div>;
}

function Vital({ name, vital, lowAt = .2 }) {
  const ratio = vital?.max > 0 ? vital.current / vital.max : null, low = ratio != null && ratio <= lowAt;
  return <div class={`vital-card ${low ? 'low' : ''}`}><small>{name}</small><strong>{percent(vital)}</strong><i><em style={{ width: `${Math.max(0, Math.min(1, ratio ?? 0)) * 100}%` }} /></i></div>;
}

const gatheredItems = run => (run?.items?.byCode ?? []).filter(item => item.gathered > 0)
  .sort((a, b) => b.gathered - a.gathered || a.code.localeCompare(b.code));

function Gathered({ run, limit = 6 }) {
  const items = gatheredItems(run), shown = items.slice(0, limit);
  if (!items.length) return <span class="run-empty">No gathered items</span>;
  return <div class="run-items">{shown.map(item => <span key={item.code}><b>{integer(item.gathered)}</b> {itemName(item.code)}</span>)}
    {items.length > shown.length && <span>+{items.length - shown.length} more</span>}</div>;
}

function CurrentRun({ run }) {
  return <section class="context-run"><div class="context-heading"><span class="eyebrow">Current run</span>
    <span class="panel-count">{run?.startedAt ? `Started ${ago(run.startedAt, now.value)}` : 'Waiting for data'}</span></div>
    {run ? <><div class="run-metric-grid"><span><small>{run.alive === false ? 'Survived' : 'Alive for'}</small><strong>{runDuration(run, now.value)}</strong></span>
      <span><small>Steps</small><strong>{integer(run.estimatedSteps)}</strong></span><span><small>Furthest (blocks)</small><strong>{blockCount(run.maxFromSpawn)}</strong></span>
      <span><small>Gathered</small><strong>{integer(run.items?.gathered)}</strong></span></div><Gathered run={run} /></>
      : <div class="panel-empty compact">Run metrics have not arrived</div>}
  </section>;
}

function RunHistory({ runs }) {
  const completed = (runs ?? []).filter(run => run.endedAt != null).slice(-8).reverse();
  return <section class="run-history panel"><div class="panel-title"><div><span class="eyebrow">Performance</span><h2>Recent runs</h2></div>
    <span class="panel-count">{completed.length} completed</span></div>
    {completed.length ? <div class="run-history-scroll"><table><thead><tr><th>Ended</th><th>Survived</th><th>Steps</th><th>Traveled</th><th>Furthest</th><th>Gathered</th></tr></thead>
      <tbody>{completed.map(run => <tr key={`${run.lifeId}:${run.startedAt}`}><td><time title={new Date(run.endedAt).toLocaleString()}>{ago(run.endedAt, now.value)}</time></td>
        <td class="run-number">{runDuration(run, now.value)}</td><td class="run-number">{integer(run.estimatedSteps)}</td><td class="run-number">{blockCount(run.distance)}</td>
        <td class="run-number">{blockCount(run.maxFromSpawn)}</td><td><Gathered run={run} limit={4} /></td></tr>)}</tbody></table></div>
      : <div class="panel-empty compact">Completed runs will appear here</div>}
  </section>;
}

export function Bot({ id }) {
  const bot = bots.value[id];
  if (!bot) return <main><div class="empty">Seraph "{id}" has not reported recently.</div></main>;
  const s = bot.topics.state?.data ?? {}, g = bot.topics.goal?.data, n = bot.topics.navigation?.data;
  const p = g?.progress ?? {}, progressRest = p.truncated ? [['progress', 'truncated']] : Object.entries(p).filter(([key]) => !shownProgressKeys.has(key));
  const hotbar = (s.hotbar ?? []).slice(0, 10);
  const debugRows = logRows(bot).filter(entry => entry.topic !== 'action' || !['control_begin', 'control_end'].includes(entry.data?.action)).reverse().slice(0, 120);
  const navigationRows = !n || n.state === 'idle' ? [['navigation', 'idle']] : [['navigation', n.state], ['target', point(n.target)], ['checkpoints left', n.remainingCheckpoints], ['replans', n.replans],
    ['last replan', n.lastReplan], ['threat', n.threat ? `${code(n.threat.code)} ${fmt(n.threat.distance)}` : null], ['navigation reason', n.reason ? words(n.reason) : null]];
  return <main class="bot-detail">
    <div class="bot-workspace">
      <div class="bot-primary"><Mission g={g} /><Live stream={bot.meta?.stream} state={s} /></div>
      <aside class="bot-context">
        <section class="context-vitals"><div class="context-heading"><span class="eyebrow">Vitals</span><span class={`life-state ${s.alive ? 'good' : 'bad'}`}><i />{s.alive ? 'Alive' : 'Dead'}</span></div>
          <div class="vital-grid"><Vital name="Health" vital={s.vitals?.health} lowAt={.3} /><Vital name="Food" vital={s.vitals?.hunger} /></div>
          <div class="context-facts"><span><small>Body</small><b>{s.condition?.bodyTemperatureC == null ? '—' : `${s.condition.bodyTemperatureC.toFixed(1)}°C`}</b></span>
            <span><small>Wetness</small><b>{s.condition?.wetness == null ? '—' : `${Math.round(s.condition.wetness * 100)}%`}</b></span><span><small>Oxygen</small><b>{percent(s.vitals?.oxygen)}</b></span></div>
        </section>
        <CurrentRun run={bot.runs?.current} />
        <section class="agent-map-panel"><div class="agent-map-heading"><span>Last position</span><b>{point(s.position) ?? 'Unknown'}</b></div><WorldMap bots={[bot]} detailed /></section>
        <section class="agent-events"><div class="context-heading"><span class="eyebrow">Recent missions</span><span class="panel-count">Latest</span></div><MissionHistory bot={bot} /></section>
        <section class="agent-events"><div class="context-heading"><span class="eyebrow">Map markers</span><span class="panel-count">{bot.topics.waypoints?.data?.count ?? 0}</span></div><MapMarkers bot={bot} /></section>
      </aside>
    </div>

    <RunHistory runs={bot.runs?.recent} />

    <details class="panel debug-panel">
      <summary class="panel-title"><div><span class="eyebrow">Operator</span><h2>Technical log &amp; goal script</h2></div><span class="panel-count">Goal {g?.id?.slice(0, 8) ?? '—'} · Expand</span></summary>
      <div class="debug-grid">
        <div class="debug-block"><h3>Goal script</h3><GoalScript g={g} />
          <Dl rows={[...progressRest, ['started', g?.startedAt ? time(g.startedAt) : null], ['finished', g?.finishedAt ? time(g.finishedAt) : null], ['reason', shortReason(g?.reason)], ['result', g?.result], ['cleanup', g?.cleanupError], ...navigationRows]} />
          <h3>Hotbar</h3><div class="hotbar">{hotbar.map(slot => <div key={slot.slot} class={slot.slot === s.activeSlot ? 'active' : ''}><b>{slot.slot}</b>{slot.code ? code(slot.code) + (slot.quantity > 1 ? ' ×' + slot.quantity : '') : <span class="muted">empty</span>}</div>)}</div>
          <h3>Nearby</h3>{s.nearbyEntities?.count ? <table><tbody>{s.nearbyEntities.nearest.map((entity, index) => <tr key={index}><td>{code(entity.code)}</td><td>{fmt(entity.distance)}</td></tr>)}</tbody></table> : <span class="muted">Nothing nearby</span>}</div>
        <div class="debug-block"><h3>Event log</h3><LogTable rows={debugRows} /></div>
      </div>
    </details>
  </main>;
}
