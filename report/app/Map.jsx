import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { atlases, positionHistory } from './store.js';
import { code, point } from './format.js';

const finitePoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.z);
const stateOf = bot => bot.topics.state?.data ?? {};
const goalOf = bot => bot.topics.goal?.data;
const navOf = bot => bot.topics.navigation?.data;
const targetOf = bot => finitePoint(goalOf(bot)?.args) ? goalOf(bot).args : finitePoint(navOf(bot)?.target) ? navOf(bot).target : null;
const fallback = { water: '#426f86', hazard: '#c5623d', canopy: '#496d3d', ground: '#746c57' };
const rgb = row => Number.isInteger(row[7]) ? `#${row[7].toString(16).padStart(6, '0')}` : fallback[row[3]];

function fit(points, aspect) {
  const xs = points.map(p => p.x), ys = points.map(p => -p.z);
  let minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  let width = Math.max(48, maxX - minX), height = Math.max(48, maxY - minY);
  const pad = Math.max(10, Math.max(width, height) * .06);
  width += pad * 2; height += pad * 2;
  if (width / height < aspect) width = height * aspect; else height = width / aspect;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return { minX: cx - width / 2, minY: cy - height / 2, width, height };
}

const niceStep = span => {
  const rough = Math.max(1, span / 7), power = 10 ** Math.floor(Math.log10(rough)), unit = rough / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
};

export function atlasStats(rows) {
  if (!rows.length) return { known: 0, oldest: null, newest: null };
  const times = rows.map(row => row[6]).filter(Number.isFinite);
  return { known: rows.length, oldest: Math.min(...times), newest: Math.max(...times) };
}

export function WorldMap({ bots, detailed = false }) {
  const atlasState = atlases.value, root = useRef(), canvas = useRef(), [aspect, setAspect] = useState(detailed ? 2.1 : 1.6), [hover, setHover] = useState(null);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setAspect(width / height);
    });
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);

  const terrain = useMemo(() => {
    const merged = new Map();
    for (const bot of bots) for (const row of atlasState[bot.id] ?? []) {
      if (!Array.isArray(row) || !Number.isFinite(row[0]) || !Number.isFinite(row[1])) continue;
      const key = `${row[0]},${row[1]}`, prior = merged.get(key);
      if (!prior || (row[6] ?? 0) >= (prior[6] ?? 0)) merged.set(key, row);
    }
    return merged;
  }, [bots, atlasState]);
  const agents = useMemo(() => bots.map((bot, index) => {
    const state = stateOf(bot), dimension = state.position?.dimension ?? 0;
    const trail = positionHistory(bot).filter(p => finitePoint(p) && (p.dimension ?? 0) === dimension);
    return { bot, index, state, trail, current: finitePoint(state.position) ? state.position : trail.at(-1), target: targetOf(bot) };
  }).filter(agent => agent.current), [bots]);
  const points = [...terrain.values()].map(row => ({ x: row[0], z: row[1] }));
  for (const agent of agents) points.push(...[...agent.trail, agent.current, agent.target].filter(finitePoint));
  const hasPoints = points.length > 0, bounds = fit(hasPoints ? points : [{ x: 0, z: 0 }], aspect);
  const step = niceStep(Math.max(bounds.width, bounds.height)), scale = bounds.width / 760;

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const draw = () => {
      const box = element.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
      if (!box.width || !box.height) return;
      element.width = Math.round(box.width * dpr); element.height = Math.round(box.height * dpr);
      const context = element.getContext('2d'); context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.fillStyle = '#071014'; context.fillRect(0, 0, box.width, box.height);
      const sx = box.width / bounds.width, sy = box.height / bounds.height;
      const elevations = [...terrain.values()].map(row => row[2]), middle = elevations.length ? elevations.reduce((a, b) => a + b, 0) / elevations.length : 0;
      for (const row of terrain.values()) {
        const size = row[4] || 1, x = (row[0] - bounds.minX) * sx, y = (-row[1] - size - bounds.minY) * sy;
        const width = Math.max(1, size * sx + .35), height = Math.max(1, size * sy + .35);
        context.fillStyle = rgb(row); context.fillRect(x, y, width, height);
        const relief = Math.max(-.2, Math.min(.18, (row[2] - middle) * .012));
        if (relief) { context.fillStyle = relief > 0 ? `rgba(255,255,255,${relief})` : `rgba(0,0,0,${-relief})`; context.fillRect(x, y, width, height); }
      }
      context.lineWidth = 1; context.strokeStyle = 'rgba(145,196,197,.16)'; context.beginPath();
      for (let x = Math.ceil(bounds.minX / step) * step; x < bounds.minX + bounds.width; x += step) {
        const px = (x - bounds.minX) * sx; context.moveTo(px, 0); context.lineTo(px, box.height);
      }
      for (let y = Math.ceil(bounds.minY / step) * step; y < bounds.minY + bounds.height; y += step) {
        const py = (y - bounds.minY) * sy; context.moveTo(0, py); context.lineTo(box.width, py);
      }
      context.stroke();
    };
    draw(); const observer = new ResizeObserver(draw); observer.observe(element); return () => observer.disconnect();
  }, [terrain, bounds.minX, bounds.minY, bounds.width, bounds.height, step]);

  if (!hasPoints) return <div class="map-empty"><span>Awaiting terrain telemetry</span><small>The atlas fills with ground the Seraph has actually seen.</small></div>;

  const inspect = event => {
    const box = root.current.getBoundingClientRect(), left = event.clientX - box.left, top = event.clientY - box.top;
    const x = Math.floor(bounds.minX + left / box.width * bounds.width);
    const z = Math.floor(-(bounds.minY + top / box.height * bounds.height));
    const row = terrain.get(`${x},${z}`) ?? terrain.get(`${Math.floor(x / 2) * 2},${Math.floor(z / 2) * 2}`) ??
      terrain.get(`${Math.floor(x / 4) * 4},${Math.floor(z / 4) * 4}`);
    setHover(row ? { row, left, top } : null);
  };

  return <div class={`world-map ${detailed ? 'detailed-map' : ''}`} ref={root} onPointerMove={inspect} onPointerLeave={() => setHover(null)}>
    <canvas ref={canvas} class="terrain-canvas" />
    <svg viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`} role="img" aria-label="Game-colored terrain seen by Seraphs, with recent paths and mission targets">
      {agents.map(({ bot, index, state, trail, current, target }) => {
        const path = trail.map(p => `${p.x},${-p.z}`).join(' '), yaw = state.orientation?.yawDegrees ?? 0, unit = Math.max(.45, scale);
        return <g key={bot.id} class={`map-agent agent-${index % 6}`}>
          {trail.length > 1 && <polyline points={path} class="map-trail map-trail-shadow" />}
          {trail.length > 1 && <polyline points={path} class="map-trail" />}
          {finitePoint(target) && <><line x1={current.x} y1={-current.z} x2={target.x} y2={-target.z} class="target-line" />
            <g transform={`translate(${target.x} ${-target.z}) scale(${unit})`} class="target-marker"><circle r={2.4} /><path d="M-4 0H4M0-4V4" /></g></>}
          <a href={`/bots/${encodeURIComponent(bot.id)}`} aria-label={`Open ${bot.id}`}>
            <g transform={`translate(${current.x} ${-current.z}) rotate(${yaw}) scale(${unit})`} class="agent-marker"><circle r={4.8} /><path d="M0 -7 L3.2 1.5 L0 .3 L-3.2 1.5 Z" /></g>
            <text x={current.x + 7 * unit} y={-current.z - 5 * unit} class="map-label" style={{ fontSize: `${8 * unit}px`, strokeWidth: 2.6 * unit }}>{bot.id}</text>
          </a>
        </g>;
      })}
    </svg>
    <div class="map-axis map-axis-x">X →</div><div class="map-axis map-axis-z">Z ↑</div>
    <div class="map-scale"><i style={{ width: `${Math.max(28, Math.min(100, step / bounds.width * 100))}%` }} />{Math.round(step)} blocks</div>
    {hover && <div class="map-readout" style={{ left: hover.left, top: hover.top }}><b>{code(hover.row[5]) ?? hover.row[3]}</b><span>{point({ x: hover.row[0], y: hover.row[2], z: hover.row[1] })}</span></div>}
  </div>;
}
