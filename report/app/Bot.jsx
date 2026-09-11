import { useEffect } from 'preact/hooks';
import { atlasFor, bots, loadAtlas, now, vitalHistory } from './store.js';
import { ago, fmt, time, code, point, phaseDetail, shownProgressKeys, stateClass, goalTitle } from './format.js';
import { Meter, Seen, GoalLine, Completion, StateTags, Dl, LogTable, logRows, Tag } from './ui.jsx';
import { atlasStats, WorldMap } from './Map.jsx';

function Sparkline({ rows }) {
  if (rows.length < 2) return <div class="muted" style={{ height: 96 }}>collecting…</div>;
  const w = 600, h = 96, t0 = rows[0].at, span = Math.max(1, rows[rows.length - 1].at - t0);
  const path = key => rows.filter(r => r[key] != null).map((r, i) => `${i ? 'L' : 'M'}${((r.at - t0) / span * w).toFixed(1)},${(h - 4 - r[key] * (h - 8)).toFixed(1)}`).join(' ');
  return <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" class="chart">
    {[.25, .5, .75].map(y => <line key={y} x1="0" x2={w} y1={h * y} y2={h * y} class="grid" />)}
    <path d={path('health')} class="series-1" /><path d={path('hunger')} class="series-2" />
  </svg>;
}
function Activity({ bot }) {
  const rows = logRows(bot).filter(e => e.topic === 'goal').reverse().slice(0, 60);
  return <div class="scroll"><table><thead><tr><th>Time</th><th>Goal</th><th>State</th><th>Phase</th></tr></thead>
    <tbody>{rows.map(e => { const g = e.data ?? {}; return <tr key={`${e.at}|${e.seq}`}><td>{time(e.at)}</td><td>{g.kind?.replace(/_/g, ' ')} {goalTitle(g)}</td>
      <td class={stateClass(g.state) === 'bad' ? 'err' : stateClass(g.state) === 'good' ? 'ok' : ''}>{g.state}{g.reason ? ' — ' + g.reason : ''}</td>
      <td>{g.progress?.phase ? g.progress.phase.replace(/_/g, ' ') : ''}{phaseDetail(g.progress) ? ' · ' + phaseDetail(g.progress) : ''}</td></tr>; })}</tbody></table></div>;
}
// The host's own live view, reached through whatever tunnel that operator registered (VINTAGE_STORY_STREAM_URL). Only web
// origins are framed; the HLS player is mediamtx's own page, so the fleet service never touches video.
function Live({ stream }) {
  if (typeof stream !== 'string' || !/^https?:\/\/[^/?#]+$/.test(stream)) return null;
  const player = `${stream}/bot/`;
  return <section class="wide live-view"><h2>Live view <a class="muted" href={player} target="_blank" rel="noopener">open ↗</a></h2>
    <iframe src={player} title="Bot display" allow="autoplay; fullscreen" referrerpolicy="no-referrer" />
    <small class="muted">HLS from this host's own tunnel, a few seconds behind. Off when the host is not streaming.</small>
  </section>;
}
export function Bot({ id }) {
  useEffect(() => loadAtlas(id), [id]);
  const bot = bots.value[id];
  if (!bot) return <main><div class="empty">Seraph "{id}" has not reported within the retention window.</div></main>;
  const s = bot.topics.state?.data ?? {}, g = bot.topics.goal?.data, n = bot.topics.navigation?.data, c = bot.topics.controller?.data, scan = bot.topics.scan?.data;
  const atlas = atlasFor(id), mapStats = atlasStats(atlas);
  const p = g?.progress ?? {}, progressRest = p.truncated ? [['progress', 'truncated']] : Object.entries(p).filter(([k]) => !shownProgressKeys.has(k));
  const hotbar = (s.hotbar ?? []).slice(0, 10);
  return <main class="grid detail">
    <div class="head wide"><b class="title">{bot.id}</b><Seen bot={bot} /><span class="muted">{bot.meta?.host}{bot.meta?.pid ? ` · pid ${bot.meta.pid}` : ''}{c?.session ? ` · session ${c.session.slice(0, 8)}` : ''}</span></div>
    <Live stream={bot.meta?.stream} />
    <section class="wide">
      <h2>Goal</h2><GoalLine g={g} />
      <div class="body"><div><Completion g={g} />
        <Dl rows={[...progressRest, ['started', g?.startedAt ? time(g.startedAt) : null], ['finished', g?.finishedAt ? time(g.finishedAt) : null], ['reason', g?.reason], ['result', g?.result], ['cleanup', g?.cleanupError], ['id', g?.id?.slice(0, 8)]]} /></div>
        <Activity bot={bot} /></div>
    </section>
    <section class="wide panel bot-map-panel">
      <div class="panel-title map-title"><div><span class="eyebrow">Seen by {bot.id}</span><h2>Explored world</h2></div>
        <span class="panel-count">{mapStats.known.toLocaleString()} columns{mapStats.oldest ? ` · ${ago(mapStats.oldest, now.value)}` : ''}</span></div>
      <WorldMap bots={[bot]} detailed />
      <div class="map-footer"><span>Game map colors</span><span>Long-horizon sight history</span><span>Blank ground is unknown</span></div>
    </section>
    <section><h2>Vitals</h2>
      <Meter name="health" vital={s.vitals?.health} lowAt={.3} /><Meter name="hunger" vital={s.vitals?.hunger} lowAt={.2} /><Meter name="oxygen" vital={s.vitals?.oxygen} lowAt={.2} />
      <StateTags s={s} n={n} />
      <h2 style={{ marginTop: 10 }}>Health / hunger <span class="legend"><i class="series-1" />health <i class="series-2" />hunger</span></h2><Sparkline rows={vitalHistory(bot.id)} />
    </section>
    <section><h2>Player</h2>
      <Dl rows={[['name', s.player?.name], ['world', s.world ? `${s.world.singleplayer ? 'singleplayer' : 'multiplayer'} · ${s.world.gameMode}` : null],
        ['position', s.position ? `${point(s.position)}${s.position.dimension ? ' (dim ' + s.position.dimension + ')' : ''}` : null],
        ['yaw / pitch', s.orientation ? `${s.orientation.yawDegrees?.toFixed(0) ?? '?'}° / ${s.orientation.pitchDegrees?.toFixed(0) ?? '?'}°` : null],
        ['target', s.target ? `${s.target.kind ?? ''} ${code(s.target.code ?? s.target.name ?? '')}`.trim() : null],
        ['body temp', s.condition?.bodyTemperatureC == null ? null : `${s.condition.bodyTemperatureC.toFixed(1)} °C`], ['stability', s.condition?.temporalStability],
        ['lives left', s.life?.livesRemaining], ['last damage', s.life?.lastDamageAt ? time(s.life.lastDamageAt) : 'none'], ['control owner', s.control?.owner?.slice(0, 8)],
        ['observed', s.observedAt ? time(s.observedAt) : null]]} />
    </section>
    <section><h2>Navigation</h2>
      <Dl rows={!n || n.state === 'idle' ? [['state', 'idle']] : [['state', n.state], ['target', point(n.target)], ['checkpoints left', n.remainingCheckpoints], ['replans', n.replans],
        ['cached cells', n.cachedCells], ['last replan', n.lastReplan], ['threat', n.threat ? `${code(n.threat.code)} ${fmt(n.threat.distance)}` : null], ['reason', n.reason]]} />
      <h2 style={{ marginTop: 10 }}>Nearby</h2>
      {s.nearbyEntities?.count ? <table><tbody>{s.nearbyEntities.nearest.map((e, i) => <tr key={i}><td>{code(e.code)}</td><td>{fmt(e.distance)}</td>{e.hostile != null && <td class={e.hostile ? 'err' : ''}>{e.hostile ? 'hostile' : ''}</td>}</tr>)}
        {s.nearbyEntities.count > s.nearbyEntities.nearest.length && <tr><td class="muted" colSpan={3}>+{s.nearbyEntities.count - s.nearbyEntities.nearest.length} more</td></tr>}</tbody></table> : <span class="muted">none</span>}
    </section>
    <section class="wide"><h2>Hotbar</h2>
      <div class="hotbar">{hotbar.map(slot => <div key={slot.slot} class={slot.slot === s.activeSlot ? 'active' : ''}><b>{slot.slot}</b>{slot.code ? code(slot.code) + (slot.quantity > 1 ? ' ×' + slot.quantity : '') : <span class="muted">empty</span>}</div>)}</div>
    </section>
    <section><h2>Seen {scan?.match && <Tag>{scan.match}</Tag>} {scan?.count != null && <span class="muted">{scan.count} total</span>}</h2>
      <div class="scroll"><table><thead><tr><th>Kind</th><th>Code</th><th>Dist</th><th>Qty</th></tr></thead>
        <tbody>{(scan?.objects ?? []).map((o, i) => <tr key={i}><td>{o.kind}</td><td>{code(o.code)}</td><td>{fmt(o.distance)}</td><td>{o.quantity ?? ''}</td></tr>)}</tbody></table></div>
    </section>
    <section><h2>Log</h2><LogTable rows={logRows(bot).reverse()} /></section>
  </main>;
}
