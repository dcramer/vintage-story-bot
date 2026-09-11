import { render } from 'preact';
import { LocationProvider, Router, Route, useLocation } from 'preact-iso';
import { connect, status, list, isLive } from './store.js';
import { Pill } from './ui.jsx';
import { Fleet } from './Fleet.jsx';
import { Bot } from './Bot.jsx';
import { Log } from './Log.jsx';
import './style.css';

function Header() {
  const { path } = useLocation();
  const bots = list.value, live = bots.filter(isLive).length;
  return <header class="command-header">
    <a href="/" class="brand" aria-label="Seraph mission control"><span class="brand-mark">S</span><span><b>Seraph</b><small>Mission control</small></span></a>
    <nav><a href="/" class={path === '/' ? 'current' : ''}>Overview</a><a href="/log" class={path === '/log' ? 'current' : ''}>Activity</a></nav>
    <div class="header-status"><Pill cls={status.value === 'live' ? 'on' : status.value === 'reconnecting' ? 'off' : ''}>{status.value}</Pill>
      <Pill cls={live ? 'on' : bots.length ? 'off' : ''}>{bots.length ? `${live} live / ${bots.length} known` : 'no Seraphs'}</Pill></div>
  </header>;
}
const NotFound = () => <main><div class="empty">Not found.</div></main>;
function App() {
  return <LocationProvider><Header /><Router><Route path="/" component={Fleet} /><Route path="/bots/:id" component={Bot} /><Route path="/log" component={Log} /><Route default component={NotFound} /></Router></LocationProvider>;
}
connect();
render(<App />, document.getElementById('app'));
