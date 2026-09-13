import { render } from 'preact';
import { LocationProvider, Router, Route, useLocation } from 'preact-iso';
import { connect, status, list, isLive } from './store.js';
import { Fleet } from './Fleet.jsx';
import { Bot } from './Bot.jsx';
import { Log } from './Log.jsx';
import { Cameras } from './Cameras.jsx';
import './style.css';

function Header() {
  const { path } = useLocation();
  const bots = list.value, live = bots.filter(isLive).length;
  const match = path.match(/^\/bots\/([^/]+)$/), id = match ? decodeURIComponent(match[1]) : null;
  const bot = id ? bots.find(item => item.id === id) : null, state = bot?.topics.state?.data;
  const connected = status.value === 'live', botState = state?.alive === false ? 'Dead' : bot?.topics.goal?.data?.active ? 'Running' : 'Connected';
  return <header class="command-header">
    <div class="header-route"><a href="/" class="brand-mark" aria-label="Seraph fleet">S</a>{id
      ? <><a href="/" class="header-parent">Fleet</a><span>/</span><b>{id}</b></>
      : <><b class="wordmark">SERAPH</b><span class="view-name">FLEET VIEW</span></>}</div>
    <nav class="fleet-nav" aria-label="Fleet views"><a href="/" aria-current={path === '/' ? 'page' : undefined}>Map</a><a href="/cameras" aria-current={path === '/cameras' ? 'page' : undefined}>Cameras</a></nav>
    <div class="header-status">{id && bot
      ? <span class={`live-status ${state?.alive === false ? 'bad' : ''}`}><i />{botState}</span>
      : <><span class="online-count"><b>{live}</b> connected</span><span class={`live-status ${connected ? '' : 'bad'}`}><i />{connected ? 'Live' : 'Reconnecting'}</span></>}</div>
  </header>;
}
const NotFound = () => <main><div class="empty">Not found.</div></main>;
function App() {
  return <LocationProvider><Header /><Router><Route path="/" component={Fleet} /><Route path="/cameras" component={Cameras} /><Route path="/bots/:id" component={Bot} /><Route path="/log" component={Log} /><Route default component={NotFound} /></Router></LocationProvider>;
}
connect();
render(<App />, document.getElementById('app'));
