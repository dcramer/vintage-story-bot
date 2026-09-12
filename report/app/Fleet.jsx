import { list, isLive } from './store.js';
import { goalTitle, point } from './format.js';
import { WorldMap } from './Map.jsx';

const pct = vital => vital?.max > 0 ? Math.max(0, Math.min(1, vital.current / vital.max)) : null;
const stateOf = bot => bot.topics.state?.data ?? {};
const goalOf = bot => bot.topics.goal?.data;
const percent = value => value == null ? '—' : `${Math.round(value * 100)}%`;
const words = value => String(value ?? '').replace(/_/g, ' ');

function ConnectedBot({ bot, index }) {
  const state = stateOf(bot), goal = goalOf(bot), dead = state.alive === false;
  const food = pct(state.vitals?.hunger);
  const activity = goalTitle(goal) || (goal ? words(goal.kind) : 'Standing by');
  const status = dead ? 'Dead' : goal?.active ? 'Running' : goal?.state === 'blocked' ? 'Blocked' : 'Connected';
  const tone = dead || goal?.state === 'blocked' ? 'bad' : goal?.active ? 'good' : '';
  return <a href={`/bots/${encodeURIComponent(bot.id)}`} class="connected-bot">
    <div class="connected-bot-head"><span class={`connected-name agent-${index % 6}`}><i />{bot.id}</span><span class={`connected-state ${tone}`}>{status}</span></div>
    <p class="connected-activity">{activity}</p>
    <div class="connected-facts"><span><small>Health</small><b>{percent(pct(state.vitals?.health))}</b></span>
      <span><small>Food</small><b class={food != null && food < .2 ? 'warn' : ''}>{percent(food)}</b></span>
      <span class="connected-position"><small>Position</small><b>{point(state.position) ?? 'Unknown'}</b></span></div>
  </a>;
}

export function Fleet() {
  const bots = list.value, live = bots.filter(isLive);
  if (!bots.length) return <main class="fleet-overview"><div class="empty-state"><h1>No bots connected</h1><p>The map appears after a bot reports.</p></div></main>;
  return <main class="fleet-overview">
    <section class="connected-panel panel">
      <div class="connected-heading"><div><span class="eyebrow">Connected</span><h1>Agents</h1></div><span>{String(live.length).padStart(2, '0')}</span></div>
      {live.length ? <div class="connected-list">{live.map((bot, index) => <ConnectedBot key={bot.id} bot={bot} index={index} />)}</div>
        : <div class="connected-empty">No bots connected. The map remains available.</div>}
    </section>
    <section class="fleet-map">
      <div class="map-heading-overlay"><span class="eyebrow">The world</span><h1>Live field map</h1></div>
      <WorldMap bots={bots} />
    </section>
  </main>;
}
