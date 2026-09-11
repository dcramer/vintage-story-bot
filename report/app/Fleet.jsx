import { list, now, isLive } from './store.js';
import { ago, goalTitle, phaseDetail, point } from './format.js';
import { WorldMap } from './Map.jsx';

const pct = vital => vital?.max > 0 ? Math.max(0, Math.min(1, vital.current / vital.max)) : null;
const stateOf = bot => bot.topics.state?.data ?? {};
const goalOf = bot => bot.topics.goal?.data;
const percent = value => value == null ? '—' : `${Math.round(value * 100)}%`;
const Fact = ({ label, children }) => <span><small>{label}</small><b>{children}</b></span>;

function ConnectedBot({ bot, index }) {
  const state = stateOf(bot), goal = goalOf(bot), progress = goal?.progress ?? {};
  const subgoal = progress.subgoal, detailProgress = subgoal?.progress ?? progress;
  const activity = goal?.active ? goalTitle(goal) || goal.kind.replace(/_/g, ' ') : 'No active goal';
  const subgoalTitle = subgoal && `${subgoal.kind.replace(/_/g, ' ')}${goalTitle(subgoal) ? ` · ${goalTitle(subgoal)}` : ''}`;
  const detail = goal?.active ? subgoalTitle ? `Now: ${subgoalTitle}` : goal.intent ? goal.kind.replace(/_/g, ' ') : null : null;
  const phase = goal?.active && detailProgress.phase ? `${detailProgress.phase.replace(/_/g, ' ')}${phaseDetail(detailProgress) ? ` · ${phaseDetail(detailProgress)}` : ''}` : null;
  return <a href={`/bots/${encodeURIComponent(bot.id)}`} class="connected-bot">
    <div class="connected-bot-head"><span class={`connected-name agent-${index % 6}`}><i />{bot.id}</span><span class="connected-seen">{ago(bot.seenAt, now.value)}</span></div>
    <div class="connected-activity"><small>Goal</small><strong>{activity}</strong>{detail && <p>{detail}</p>}{phase && <p>{phase}</p>}</div>
    <div class="connected-facts"><Fact label="Health">{percent(pct(state.vitals?.health))}</Fact><Fact label="Food">{percent(pct(state.vitals?.hunger))}</Fact>
      <Fact label="Position">{point(state.position) ?? 'Unknown'}</Fact></div>
  </a>;
}

export function Fleet() {
  const bots = list.value, live = bots.filter(isLive);
  if (!bots.length) return <main class="fleet-overview"><div class="empty-state"><h1>No bots connected</h1><p>The map appears after a bot reports.</p></div></main>;
  return <main class="fleet-overview">
    <section class="map-panel panel">
      <div class="panel-title map-title"><h1>Map</h1><div class="map-legend">{live.map((bot, index) => <span key={bot.id}><i class={`agent-${index % 6}`} />{bot.id}</span>)}
        <span class="player-key"><i />Other players</span></div></div>
      <WorldMap bots={bots} />
    </section>
    <section class="connected-panel panel">
      <div class="panel-title"><h2>Bots</h2></div>
      {live.length ? <div class="connected-list">{live.map((bot, index) => <ConnectedBot key={bot.id} bot={bot} index={index} />)}</div>
        : <div class="connected-empty">No bots connected. The map remains available.</div>}
    </section>
  </main>;
}
