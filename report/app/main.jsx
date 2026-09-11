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
  return <header>
    <h1><a href="/">Seraph fleet</a></h1>
    <nav><a href="/" class={path === '/' ? 'current' : ''}>Fleet</a><a href="/log" class={path === '/log' ? 'current' : ''}>Log</a></nav>
    <Pill cls={status.value === 'live' ? 'on' : status.value === 'reconnecting' ? 'off' : ''}>{status.value}</Pill>
    <Pill cls={live ? 'on' : bots.length ? 'off' : ''}>{bots.length ? `${live} live / ${bots.length} known` : 'no bots'}</Pill>
  </header>;
}
const NotFound = () => <main><div class="empty">Not found.</div></main>;
function App() {
  return <LocationProvider><Header /><Router><Route path="/" component={Fleet} /><Route path="/bots/:id" component={Bot} /><Route path="/log" component={Log} /><Route default component={NotFound} /></Router></LocationProvider>;
}
connect();
render(<App />, document.getElementById('app'));
