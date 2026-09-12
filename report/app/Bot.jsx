import { bots, now } from './store.js';
import { ago, fmt, time, code, point, phaseDetail, shownProgressKeys, stateClass, goalTitle } from './format.js';
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

function MissionHistory({ bot }) {
  const rows = [], seen = new Set();
  for (const entry of logRows(bot).filter(event => event.topic === 'goal').reverse()) {
    const key = entry.data?.id ?? `${entry.at}:${entry.seq}`;
    if (seen.has(key)) continue;
    seen.add(key); rows.push(entry);
    if (rows.length === 4) break;
  }
  return <div class="mission-list">{rows.length ? rows.map(entry => {
    const g = entry.data ?? {}, p = g.progress?.subgoal?.progress ?? g.progress ?? {};
    return <div class="mission-row" key={`${entry.at}:${entry.seq}`}>
      <div><strong>{goalTitle(g) || words(g.kind)}</strong><small>{p.phase ? words(p.phase) : shortReason(g.reason) || 'Mission update'}{phaseDetail(p) ? ` · ${phaseDetail(p)}` : ''}</small></div>
      <span class={stateClass(g.state)}>{words(g.state)}</span><time>{time(entry.at)}</time>
    </div>;
  }) : <div class="panel-empty compact">No missions reported</div>}</div>;
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
        <section class="agent-map-panel"><div class="agent-map-heading"><span>Last position</span><b>{point(s.position) ?? 'Unknown'}</b></div><WorldMap bots={[bot]} detailed /></section>
        <section class="agent-events"><div class="context-heading"><span class="eyebrow">Recent missions</span><span class="panel-count">Latest</span></div><MissionHistory bot={bot} /></section>
      </aside>
    </div>

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
