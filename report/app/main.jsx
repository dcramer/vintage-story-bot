import { render } from 'preact';
import { LocationProvider, Router, Route } from 'preact-iso';
import { connect, status, list, isLive } from './store.js';
import { Pill } from './ui.jsx';
import { Fleet } from './Fleet.jsx';
import { Bot } from './Bot.jsx';
import { Log } from './Log.jsx';
import './style.css';

function Header() {
  const bots = list.value, live = bots.filter(isLive).length;
  const connected = status.value === 'live';
  return <header class="command-header">
    <a href="/" class="brand" aria-label="Seraph"><b>Seraph</b></a>
    <div class="header-status"><Pill cls={connected && live ? 'on' : connected ? '' : 'off'}>{connected ? `${live} bot${live === 1 ? '' : 's'} connected` : 'Reconnecting'}</Pill></div>
  </header>;
}
const NotFound = () => <main><div class="empty">Not found.</div></main>;
function App() {
  return <LocationProvider><Header /><Router><Route path="/" component={Fleet} /><Route path="/bots/:id" component={Bot} /><Route path="/log" component={Log} /><Route default component={NotFound} /></Router></LocationProvider>;
}
connect();
render(<App />, document.getElementById('app'));
