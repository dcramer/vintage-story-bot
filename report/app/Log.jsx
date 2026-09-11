import { useSignal } from '@preact/signals';
import { list } from './store.js';
import { logBad, logDetail } from './format.js';
import { LogTable, logRows } from './ui.jsx';

export function Log() {
  const bot = useSignal(''), topic = useSignal(''), failures = useSignal(false), text = useSignal('');
  const all = list.value.flatMap(logRows);
  const topics = [...new Set(all.map(e => e.topic))].sort();
  const needle = text.value.trim().toLowerCase();
  const rows = all.filter(e => (!bot.value || e.bot === bot.value) && (!topic.value || e.topic === topic.value) && (!failures.value || logBad(e))
    && (!needle || logDetail(e).toLowerCase().includes(needle))).sort((a, b) => b.at - a.at).slice(0, 500);
  return <main>
    <section class="wide">
      <div class="filters">
        <select value={bot.value} onChange={e => { bot.value = e.currentTarget.value; }}><option value="">all bots</option>{list.value.map(b => <option key={b.id} value={b.id}>{b.id}</option>)}</select>
        <select value={topic.value} onChange={e => { topic.value = e.currentTarget.value; }}><option value="">all topics</option>{topics.map(t => <option key={t} value={t}>{t}</option>)}</select>
        <label><input type="checkbox" checked={failures.value} onChange={e => { failures.value = e.currentTarget.checked; }} /> failures only</label>
        <input type="search" placeholder="filter text" value={text.value} onInput={e => { text.value = e.currentTarget.value; }} />
        <span class="muted">{rows.length} of {all.length}</span>
      </div>
      <LogTable rows={rows} withBot />
    </section>
  </main>;
}
