import { useEffect, useMemo, useState } from 'preact/hooks';
import { positionHistory } from './store.js';

const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.z);
const stateOf = bot => bot.topics.state?.data ?? {};
const goalOf = bot => bot.topics.goal?.data;
const navOf = bot => bot.topics.navigation?.data;
const targetOf = bot => finitePoint(goalOf(bot)?.args) ? goalOf(bot).args : finitePoint(navOf(bot)?.target) ? navOf(bot).target : null;

function project(point, view, height) {
  if (!finitePoint(point) || !view?.world || !view.here || !view.east100 || !view.south100) return null;
  const dx = (point.x - view.world.x) / 100, dz = (point.z - view.world.z) / 100;
  return {
    x: (view.here[0] + dx * (view.east100[0] - view.here[0]) + dz * (view.south100[0] - view.here[0])) * 1000,
    y: (view.here[1] + dx * (view.east100[1] - view.here[1]) + dz * (view.south100[1] - view.here[1])) * height,
  };
}

const inside = (point, height) => point && point.x > -40 && point.x < 1040 && point.y > -40 && point.y < height + 40;
function contiguousTrails(points) {
  const trails = [];
  for (const point of points) {
    const trail = trails.at(-1), prior = trail?.at(-1);
    if (!prior || Math.hypot(point.x - prior.x, point.z - prior.z) > 128) trails.push([point]);
    else trail.push(point);
  }
  return trails;
}

export function WorldMap({ bots, detailed = false }) {
  const sources = bots.filter(bot => bot.mapImage?.at).sort((a, b) => b.mapImage.at - a.mapImage.at);
  const [selected, setSelected] = useState(null);
  useEffect(() => {
    if (!sources.some(bot => bot.id === selected)) setSelected(sources[0]?.id ?? null);
  }, [sources.map(bot => `${bot.id}:${bot.mapImage.at}`).join('|'), selected]);
  const source = sources.find(bot => bot.id === selected) ?? sources[0];
  const viewHeight = source ? 1000 * source.mapImage.height / source.mapImage.width : 562.5;
  const agents = useMemo(() => !source?.mapImage?.view ? [] : bots.map((bot, index) => {
    const state = stateOf(bot), dimension = state.position?.dimension ?? 0;
    if (dimension !== source.mapImage.view.world.dimension) return null;
    const trail = positionHistory(bot).filter(point => finitePoint(point) && (point.dimension ?? 0) === dimension);
    const current = finitePoint(state.position) ? state.position : trail.at(-1), target = targetOf(bot);
    return current ? { bot, index, state, current: project(current, source.mapImage.view, viewHeight), target: project(target, source.mapImage.view, viewHeight),
      trails: contiguousTrails(trail).map(points => points.map(point => project(point, source.mapImage.view, viewHeight)).filter(Boolean)) } : null;
  }).filter(Boolean), [bots, source, viewHeight]);

  if (!source) return <div class="map-empty"><span>Awaiting a World Map capture</span><small>The host will lift the next idle snapshot from Vintage Story itself.</small></div>;
  const image = `/api/map-image/${encodeURIComponent(source.id)}?v=${source.mapImage.at}`;
  return <div class={`world-map native-world-map ${detailed ? 'detailed-map' : ''}`}
    style={{ aspectRatio: `${source.mapImage.width} / ${source.mapImage.height}` }}>
    <img src={image} alt={`${source.id}'s Vintage Story World Map`} />
    <svg viewBox={`0 0 1000 ${viewHeight}`} role="img" aria-label={`Telemetry over ${source.id}'s captured Vintage Story World Map`}>
      {agents.map(({ bot, index, state, trails, current, target }) => {
        const yaw = state.orientation?.yawDegrees ?? 0;
        return <g key={bot.id} class={`map-agent agent-${index % 6}`}>
          {trails.map((trail, trailIndex) => trail.length > 1 && <g key={trailIndex}>
            <polyline points={trail.map(point => `${point.x},${point.y}`).join(' ')} class="map-trail map-trail-shadow" />
            <polyline points={trail.map(point => `${point.x},${point.y}`).join(' ')} class="map-trail" />
          </g>)}
          {inside(current, viewHeight) && inside(target, viewHeight) && <><line x1={current.x} y1={current.y} x2={target.x} y2={target.y} class="target-line" />
            <g transform={`translate(${target.x} ${target.y})`} class="target-marker"><circle r="5" /><path d="M-9 0H9M0-9V9" /></g></>}
          {inside(current, viewHeight) && <a href={`/bots/${encodeURIComponent(bot.id)}`} aria-label={`Open ${bot.id}`}>
            <g transform={`translate(${current.x} ${current.y}) rotate(${yaw})`} class="agent-marker"><circle r="9" /><path d="M0 -13 L6 3 L0 1 L-6 3 Z" /></g>
            <text x={current.x + 13} y={current.y - 10} class="map-label">{bot.id}</text>
          </a>}
        </g>;
      })}
    </svg>
    <div class="native-map-source">Captured from {source.id}</div>
    {sources.length > 1 && <div class="map-source-picker" aria-label="World Map source">{sources.map(bot =>
      <button key={bot.id} class={bot.id === source.id ? 'selected' : ''} onClick={() => setSelected(bot.id)}>{bot.id}</button>)}</div>}
  </div>;
}
