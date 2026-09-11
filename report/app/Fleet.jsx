import { list, retentionMs, isLive } from './store.js';
import { point, code } from './format.js';
import { Meter, Seen, GoalLine, StateTags, Dl } from './ui.jsx';

function Card({ bot }) {
  const s = bot.topics.state?.data ?? {}, g = bot.topics.goal?.data, n = bot.topics.navigation?.data;
  return <a class={`card ${isLive(bot) ? '' : 'stale'}`} href={`/bots/${encodeURIComponent(bot.id)}`}>
    <div class="head"><b>{bot.id}</b>{s.player?.name && s.player.name !== bot.id && <span class="muted">{s.player.name}</span>}<Seen bot={bot} /></div>
    <GoalLine g={g} />
    <Meter name="health" vital={s.vitals?.health} lowAt={.3} /><Meter name="hunger" vital={s.vitals?.hunger} lowAt={.2} />
    <StateTags s={s} n={n} />
    <Dl rows={[['position', point(s.position)],
      ['navigation', n && n.state !== 'idle' ? `${n.state}${n.target ? ' → ' + point(n.target) : ''}${n.remainingWaypoints != null ? ' · ' + n.remainingWaypoints + ' wp' : ''}` : null],
      ['nearby', s.nearbyEntities?.count ? s.nearbyEntities.nearest.slice(0, 3).map(e => `${code(e.code)} ${Math.round(e.distance)}`).join(', ') + (s.nearbyEntities.count > 3 ? ` +${s.nearbyEntities.count - 3}` : '') : null]]} />
  </a>;
}
export function Fleet() {
  const bots = list.value;
  return <main class="grid">
    {bots.length ? bots.map(bot => <Card key={bot.id} bot={bot} />)
      : <div class="empty">No bots have reported{retentionMs.value ? ` in the last ${Math.round(retentionMs.value / 3600000)}h` : ''}.</div>}
  </main>;
}
