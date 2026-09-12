import { bots, now, vitalHistory } from './store.js';
import { ago, fmt, time, code, point, phaseDetail, shownProgressKeys, stateClass, goalTitle } from './format.js';
import { Meter, Seen, Completion, StateTags, Dl, LogTable, logRows, Tag } from './ui.jsx';
import { WorldMap } from './Map.jsx';

const words = value => String(value ?? '').replace(/_/g, ' ');
const percent = vital => vital?.max > 0 ? `${Math.round(vital.current / vital.max * 100)}%` : 'Unknown';
const shortReason = value => String(value ?? '').replace(/^Error:\s*/, '').replace(/^Goal \d+\/\d+ \([^)]+\) failed:\s*/, '');

function Sparkline({ rows }) {
  if (rows.length < 2) return <div class="chart-empty">Collecting history</div>;
  const w = 600, h = 96, t0 = rows[0].at, span = Math.max(1, rows[rows.length - 1].at - t0);
  const path = key => rows.filter(r => r[key] != null).map((r, i) => `${i ? 'L' : 'M'}${((r.at - t0) / span * w).toFixed(1)},${(h - 4 - r[key] * (h - 8)).toFixed(1)}`).join(' ');
  return <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" class="chart">
    {[.25, .5, .75].map(y => <line key={y} x1="0" x2={w} y1={h * y} y2={h * y} class="grid" />)}
    <path d={path('health')} class="series-1" /><path d={path('hunger')} class="series-2" />
  </svg>;
}

function Mission({ g }) {
  const p = g?.progress ?? {}, subgoal = p.subgoal, detail = subgoal?.progress ?? p;
  const title = goalTitle(g) || (g ? words(g.kind) : 'Standing by');
  const step = subgoal ? `${words(subgoal.kind)}${goalTitle(subgoal) ? ` — ${goalTitle(subgoal)}` : ''}` : null;
  const phase = detail.phase ? `${words(detail.phase)}${phaseDetail(detail) ? ` — ${phaseDetail(detail)}` : ''}` : null;
  return <section class="mission-hero">
    <div class="mission-kicker"><span>{g?.active ? 'Current Mission' : g ? 'Last Mission' : 'Mission'}</span>
      <div class="tags"><Tag cls={stateClass(g?.state)}>{words(g?.state ?? 'idle')}</Tag>{g?.active && <Tag cls="good">live</Tag>}
        {g?.startedAt && <Tag>{ago(g.finishedAt ?? g.startedAt, now.value)}</Tag>}</div></div>
    <h1>{title}</h1>
    {(step || phase) && <p class="mission-step">{step}{step && phase ? ' · ' : ''}{phase}</p>}
    {g?.reason && <p class="mission-reason">{shortReason(g.reason)}</p>}
    <Completion g={g} />
  </section>;
}

function Live({ stream }) {
  const valid = typeof stream === 'string' && /^https?:\/\/[^/?#]+$/.test(stream), player = valid ? `${stream}/bot/` : null;
  return <section class="panel live-console">
    <div class="panel-title"><h2>Live Stream</h2>{player && <a class="panel-link" href={player} target="_blank" rel="noopener">Open stream ↗</a>}</div>
    {player ? <><div class="live-frame"><iframe src={player} title="Bot display" allow="autoplay; fullscreen" referrerpolicy="no-referrer" /></div>
      <div class="live-foot">A few seconds behind</div></> : <div class="panel-empty">Stream unavailable</div>}
  </section>;
}

function MissionHistory({ bot }) {
  const rows = [], seen = new Set();
  for (const entry of logRows(bot).filter(e => e.topic === 'goal').reverse()) {
    const key = entry.data?.id ?? `${entry.at}:${entry.seq}`;
    if (seen.has(key)) continue;
    seen.add(key); rows.push(entry);
    if (rows.length === 8) break;
  }
  return <div class="mission-list">{rows.length ? rows.map(entry => {
    const g = entry.data ?? {}, p = g.progress?.subgoal?.progress ?? g.progress ?? {};
    return <div class="mission-row" key={`${entry.at}:${entry.seq}`}>
      <div><strong>{goalTitle(g) || words(g.kind)}</strong><small>{p.phase ? words(p.phase) : 'No phase reported'}{phaseDetail(p) ? ` · ${phaseDetail(p)}` : ''}</small></div>
      <span class={stateClass(g.state)}>{words(g.state)}</span><time>{time(entry.at)}</time>
    </div>;
  }) : <div class="panel-empty compact">No missions reported</div>}</div>;
}

function GoalScript({ g }) {
  const source = g?.args?.goalScript;
  return source ? <pre class="goal-script"><code>{source}</code></pre>
    : <div class="panel-empty compact">{g?.kind === 'goal_script' ? 'Script was not reported for this run' : 'No composed goal script'}</div>;
}

export function Bot({ id }) {
  const bot = bots.value[id];
  if (!bot) return <main><div class="empty">Seraph "{id}" has not reported recently.</div></main>;
  const s = bot.topics.state?.data ?? {}, g = bot.topics.goal?.data, n = bot.topics.navigation?.data;
  const p = g?.progress ?? {}, progressRest = p.truncated ? [['progress', 'truncated']] : Object.entries(p).filter(([k]) => !shownProgressKeys.has(k));
  const hotbar = (s.hotbar ?? []).slice(0, 10);
  const debugRows = logRows(bot).filter(entry => entry.topic !== 'action' || !['control_begin', 'control_end'].includes(entry.data?.action)).reverse().slice(0, 120);
  const navigationRows = !n || n.state === 'idle' ? [['state', 'idle']] : [['state', n.state], ['target', point(n.target)], ['checkpoints left', n.remainingCheckpoints], ['replans', n.replans],
    ['last replan', n.lastReplan], ['threat', n.threat ? `${code(n.threat.code)} ${fmt(n.threat.distance)}` : null], ['reason', n.reason ? words(n.reason) : null]];
  return <main class="bot-detail">
    <div class="bot-titlebar"><div><a href="/" class="back-link">← Fleet</a><b>{bot.id}</b></div><Seen bot={bot} /></div>
    <Mission g={g} />

    <div class="bot-stage">
      <Live stream={bot.meta?.stream} />
      <aside class="bot-rail">
        <section class="panel rail-card">
          <div class="panel-title"><h2>Vitals</h2><span class="panel-count">{s.alive ? 'Alive' : 'Dead'}</span></div>
          <div class="rail-body"><Meter name="health" vital={s.vitals?.health} lowAt={.3} /><Meter name="hunger" vital={s.vitals?.hunger} lowAt={.2} /><Meter name="oxygen" vital={s.vitals?.oxygen} lowAt={.2} />
            <StateTags s={s} n={n} /></div>
        </section>
        <section class="panel rail-card">
          <div class="panel-title"><h2>Position</h2><span class="panel-count">{s.world?.singleplayer ? 'Singleplayer' : 'Multiplayer'}</span></div>
          <div class="rail-body"><div class="position-value">{point(s.position) ?? 'Unknown'}</div>
            <Dl rows={[['world', s.world?.gameMode], ['heading', s.orientation?.yawDegrees == null ? null : `${s.orientation.yawDegrees.toFixed(0)}°`],
              ['target', s.target ? code(s.target.code ?? s.target.name) : null], ['last damage', s.life?.lastDamageAt ? time(s.life.lastDamageAt) : 'None']]} /></div>
        </section>
        <section class="panel rail-card">
          <div class="panel-title"><h2>Health and Hunger</h2><span class="panel-count">This session</span></div>
          <div class="rail-body"><Sparkline rows={vitalHistory(bot.id)} /><div class="chart-legend"><span><i class="series-1" />Health {percent(s.vitals?.health)}</span><span><i class="series-2" />Hunger {percent(s.vitals?.hunger)}</span></div></div>
        </section>
      </aside>
    </div>

    <section class="panel bot-map-panel">
      <div class="panel-title map-title"><h2>Explored Map</h2>
        <span class="panel-count">{bot.nativeMap?.count ? `${bot.nativeMap.count.toLocaleString()} chunks · ${ago(bot.nativeMap.at, now.value)}` : 'Waiting for map sync'}</span></div>
      <WorldMap bots={[bot]} detailed />
    </section>

    <div class="bot-secondary">
      <section class="panel">
        <div class="panel-title"><h2>Recent Missions</h2></div><MissionHistory bot={bot} />
      </section>
      <section class="panel">
        <div class="panel-title"><h2>Navigation</h2></div><div class="card-body"><Dl rows={navigationRows} />
          <h3>Nearby</h3>{s.nearbyEntities?.count ? <table><tbody>{s.nearbyEntities.nearest.map((e, i) => <tr key={i}><td>{code(e.code)}</td><td>{fmt(e.distance)}</td>{e.hostile != null && <td class={e.hostile ? 'err' : ''}>{e.hostile ? 'hostile' : ''}</td>}</tr>)}</tbody></table> : <span class="muted">Nothing nearby</span>}</div>
      </section>
      <section class="panel">
        <div class="panel-title"><h2>Inventory</h2><span class="panel-count">Hotbar</span></div>
        <div class="card-body"><div class="hotbar">{hotbar.map(slot => <div key={slot.slot} class={slot.slot === s.activeSlot ? 'active' : ''}><b>{slot.slot}</b>{slot.code ? code(slot.code) + (slot.quantity > 1 ? ' ×' + slot.quantity : '') : <span class="muted">empty</span>}</div>)}</div></div>
      </section>
    </div>

    <section class="panel debug-panel">
      <div class="panel-title"><h2>Debug</h2><span class="panel-count">Goal {g?.id?.slice(0, 8) ?? '—'}</span></div>
      <div class="debug-grid">
        <div class="debug-block"><h3>Goal Script</h3><GoalScript g={g} />
          <Dl rows={[...progressRest, ['started', g?.startedAt ? time(g.startedAt) : null], ['finished', g?.finishedAt ? time(g.finishedAt) : null], ['reason', shortReason(g?.reason)], ['result', g?.result], ['cleanup', g?.cleanupError]]} /></div>
        <div class="debug-block"><h3>Event Log</h3><LogTable rows={debugRows} /></div>
      </div>
    </section>
  </main>;
}
