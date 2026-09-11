import { list, now, isLive } from './store.js';
import { ago, goalTitle, phaseDetail, point } from './format.js';
import { WorldMap } from './Map.jsx';

const pct = vital => vital?.max > 0 ? Math.max(0, Math.min(1, vital.current / vital.max)) : null;
const stateOf = bot => bot.topics.state?.data ?? {};
const goalOf = bot => bot.topics.goal?.data;

function Vital({ label, value }) {
  return <div class="connected-vital"><span>{label}<b>{value == null ? '—' : `${Math.round(value * 100)}%`}</b></span>
    <div><i style={{ width: `${(value ?? 0) * 100}%` }} /></div></div>;
}

function ConnectedBot({ bot, index }) {
  const state = stateOf(bot), goal = goalOf(bot), progress = goal?.progress ?? {};
  const activity = goal?.active ? goal.kind.replace(/_/g, ' ') : 'Idle';
  const detail = goal?.active ? goalTitle(goal) || progress.phase?.replace(/_/g, ' ') || 'Working' : 'Standing by';
  const phase = goal?.active && progress.phase ? `${progress.phase.replace(/_/g, ' ')}${phaseDetail(progress) ? ` · ${phaseDetail(progress)}` : ''}` : null;
  return <a href={`/bots/${encodeURIComponent(bot.id)}`} class="connected-bot">
    <div class="connected-bot-head"><span class={`connected-name agent-${index % 6}`}><i />{bot.id}</span><span class="connected-state">Connected</span></div>
    <div class="connected-activity"><span>Current activity</span><strong>{activity}</strong><p>{detail}</p>{phase && <small>{phase}</small>}</div>
    <div class="connected-vitals"><Vital label="Health" value={pct(state.vitals?.health)} /><Vital label="Food" value={pct(state.vitals?.hunger)} /></div>
    <div class="connected-position"><span>Position</span><b>{point(state.position) ?? 'Unknown'}</b><small>{ago(bot.seenAt, now.value)}</small></div>
  </a>;
}

export function Fleet() {
  const bots = list.value, live = bots.filter(isLive);
  if (!bots.length) return <main class="fleet-overview"><div class="empty-state"><span class="radar-empty" /><h1>Waiting for bots</h1><p>The map will appear when a bot connects.</p></div></main>;
  return <main class="fleet-overview">
    <section class="map-panel panel">
      <div class="panel-title map-title"><div><span class="eyebrow">Shared exploration</span><h1>World map</h1></div>
        <div class="map-legend">{live.map((bot, index) => <span key={bot.id}><i class={`agent-${index % 6}`} />{bot.id}</span>)}</div></div>
      <WorldMap bots={bots} />
      <div class="map-footer"><span>Colored markers are connected bots</span><span>White markers are other visible players</span><span>Drag or scroll to navigate</span></div>
    </section>
    <section class="connected-panel panel">
      <div class="panel-title"><div><span class="eyebrow">Online now</span><h2>Connected bots</h2></div><span class="panel-count">{live.length}</span></div>
      {live.length ? <div class="connected-list">{live.map((bot, index) => <ConnectedBot key={bot.id} bot={bot} index={index} />)}</div>
        : <div class="connected-empty"><strong>No bots connected</strong><span>The last explored map remains available.</span></div>}
    </section>
  </main>;
}
