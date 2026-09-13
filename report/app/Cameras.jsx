import { useState } from 'preact/hooks';
import { list, isLive, now } from './store.js';
import { ago, goalTitle, point } from './format.js';
import './cameras.css';

const playerUrl = bot => typeof bot.meta?.stream === 'string' && /^https?:\/\/[^/?#]+$/.test(bot.meta.stream)
  ? `${bot.meta.stream}/bot/` : null;

function Vital({ label, vital }) {
  const value = vital?.max > 0 ? Math.max(0, Math.min(100, Math.round(vital.current / vital.max * 100))) : null;
  return <span class={`camera-vital ${value != null && value <= 20 ? 'low' : ''}`}><small>{label}</small><b>{value == null ? '—' : `${value}%`}</b></span>;
}

function Camera({ bot, index, paused }) {
  const [reload, setReload] = useState(0);
  const online = isLive(bot), player = playerUrl(bot), state = bot.topics.state?.data ?? {}, goal = bot.topics.goal?.data;
  const label = !online ? 'Offline' : state.alive === false ? 'Dead' : goal?.active ? 'Running' : 'Standing by';
  return <article class={`camera-card ${online ? '' : 'offline'}`}>
    <div class="camera-heading"><a href={`/bots/${encodeURIComponent(bot.id)}`}><span class="camera-number">{String(index + 1).padStart(2, '0')}</span><h2>{bot.id}</h2></a>
      <span class={`camera-status ${!online || state.alive === false ? 'quiet' : ''}`}><i />{label}</span></div>
    <div class="camera-screen">
      {player && online && !paused
        ? <iframe key={`${player}:${reload}`} src={`${player}?muted=true&autoplay=true`} title={`${bot.id} camera`} allow="autoplay; fullscreen" allowFullScreen referrerpolicy="no-referrer" />
        : <div class="camera-placeholder"><span class="camera-reticle" aria-hidden="true" /><b>{!online ? 'Seraph offline' : !player ? 'No stream connected' : 'Playback paused'}</b><p>{!online ? `Last report ${ago(bot.seenAt, now.value)}` : !player ? 'Telemetry is available. Waiting for a camera.' : 'Resume to watch this camera.'}</p></div>}
    </div>
    <div class="camera-detail"><div class="camera-activity"><small>{online ? 'Current activity' : 'Last activity'}</small><p>{goal?.active ? goalTitle(goal) : state.alive === false ? 'Awaiting respawn' : 'Standing by'}</p></div>
      <div class="camera-vitals"><Vital label="Health" vital={state.vitals?.health} /><Vital label="Satiety" vital={state.vitals?.hunger} /></div></div>
    <div class="camera-footer"><span title="Last reported position">{point(state.position) ?? 'Position unknown'}</span><div>{player && <><button type="button" disabled={!online || paused} onClick={() => setReload(reload + 1)} aria-label={`Reload ${bot.id} camera`}>Reload</button><a href={player} target="_blank" rel="noopener noreferrer" aria-label={`Open ${bot.id} stream`}>Open ↗</a></>}<a href={`/bots/${encodeURIComponent(bot.id)}`}>Details →</a></div></div>
  </article>;
}

export function Cameras() {
  const [paused, setPaused] = useState(false), [compact, setCompact] = useState(false);
  // Reports arrive independently: keep cameras in fixed name order as telemetry changes.
  const bots = [...list.value].sort((a, b) => a.id.localeCompare(b.id));
  const connected = bots.filter(isLive).length, streams = bots.filter(playerUrl).length;
  return <main class="cameras-page">
    <div class="cameras-heading"><div><span class="eyebrow">Fleet observation</span><h1>Cameras</h1><p>A window into every Seraph’s world.</p></div><div class="camera-summary"><b>{String(streams).padStart(2, '0')}</b><span>cameras configured<br />{connected} of {bots.length} Seraphs connected</span></div></div>
    <div class="camera-toolbar"><span>{paused ? 'Playback paused · telemetry continues' : 'Muted autoplay · streams may be a few seconds behind'}</span><div><button type="button" aria-pressed={compact} onClick={() => setCompact(!compact)}>Compact grid</button><button type="button" aria-pressed={paused} onClick={() => setPaused(!paused)}>{paused ? 'Resume cameras' : 'Pause cameras'}</button></div></div>
    {bots.length ? <div class={`camera-grid ${compact ? 'compact' : ''}`}>{bots.map((bot, index) => <Camera key={bot.id} bot={bot} index={index} paused={paused} />)}</div>
      : <div class="empty-state"><h2>No cameras yet</h2><p>Each Seraph appears here when it reports to the fleet.</p></div>}
  </main>;
}
