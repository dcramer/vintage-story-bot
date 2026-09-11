import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { positionHistory } from './store.js';

const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.z);
const stateOf = bot => bot.topics.state?.data ?? {};
const goalOf = bot => bot.topics.goal?.data;
const navOf = bot => bot.topics.navigation?.data;
const targetOf = bot => finitePoint(goalOf(bot)?.args) ? goalOf(bot).args : finitePoint(navOf(bot)?.target) ? navOf(bot).target : null;
const query = bot => bot ? `?bot=${encodeURIComponent(bot)}` : '';
const manifestCache = new Map(), regionCache = new Map(), maxCachedRegions = 192;

function contiguousTrails(points) {
  const trails = [];
  for (const point of points) {
    const trail = trails.at(-1), prior = trail?.at(-1);
    if (!prior || Math.hypot(point.x - prior.x, point.z - prior.z) > 128) trails.push([point]);
    else trail.push(point);
  }
  return trails;
}

function decodePixels(value) {
  const binary = atob(value), pixels = new Uint8ClampedArray(binary.length);
  for (let index = 0; index < binary.length; index++) pixels[index] = binary.charCodeAt(index);
  return pixels;
}

async function loadManifest(world, bot, revision) {
  const key = `${world}:${bot ?? '*'}:${revision}`;
  if (manifestCache.has(key)) return manifestCache.get(key);
  const promise = (async () => {
    const suffix = query(bot), manifestResponse = await fetch(`/api/native-map/${encodeURIComponent(world)}${suffix}`);
    if (!manifestResponse.ok) throw new Error(`Map manifest returned HTTP ${manifestResponse.status}`);
    return manifestResponse.json();
  })();
  manifestCache.set(key, promise);
  if (manifestCache.size > 12) manifestCache.delete(manifestCache.keys().next().value);
  try { return await promise; } catch (error) { manifestCache.delete(key); throw error; }
}

async function loadRegion(world, bot, revision, x, z) {
  const key = `${world}:${bot ?? '*'}:${revision}:${x}:${z}`;
  if (regionCache.has(key)) return regionCache.get(key);
  const promise = (async () => {
    const response = await fetch(`/api/native-map/${encodeURIComponent(world)}/region/${x}/${z}${query(bot)}`);
    if (!response.ok) throw new Error(`Map region returned HTTP ${response.status}`);
    const region = await response.json();
    return region.chunks.map(([chunkX, chunkZ, pixels]) => ({ x: chunkX, z: chunkZ, pixels: decodePixels(pixels) }));
  })();
  regionCache.set(key, promise);
  if (regionCache.size > maxCachedRegions) regionCache.delete(regionCache.keys().next().value);
  try { return await promise; } catch (error) { regionCache.delete(key); throw error; }
}

function tile(pixels) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
  canvas.getContext('2d').putImageData(new ImageData(pixels, 32, 32), 0, 0);
  return canvas;
}

function Terrain({ map, camera, onSize, size }) {
  const ref = useRef(null), tiles = useMemo(() => map.chunks.map(chunk => ({ ...chunk, image: tile(chunk.pixels) })), [map]);
  useEffect(() => {
    const canvas = ref.current, resize = () => {
      const bounds = canvas.getBoundingClientRect(), ratio = devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(bounds.width * ratio)); canvas.height = Math.max(1, Math.round(bounds.height * ratio));
      onSize({ width: bounds.width, height: bounds.height, ratio });
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    return () => observer.disconnect();
  }, [onSize]);
  useEffect(() => {
    const canvas = ref.current, bounds = canvas.getBoundingClientRect(), ratio = devicePixelRatio || 1;
    if (!camera || !bounds.width || !bounds.height) return;
    const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, bounds.width, bounds.height);
    ctx.fillStyle = '#061014'; ctx.fillRect(0, 0, bounds.width, bounds.height); ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#102126';
    for (const [regionX, regionZ] of map.regions) {
      const x = (regionX * 256 - camera.x) * camera.zoom + bounds.width / 2;
      const y = (regionZ * 256 - camera.z) * camera.zoom + bounds.height / 2, regionSize = 256 * camera.zoom;
      if (x + regionSize < 0 || y + regionSize < 0 || x > bounds.width || y > bounds.height) continue;
      ctx.fillRect(Math.floor(x), Math.floor(y), Math.max(1, Math.ceil(regionSize)), Math.max(1, Math.ceil(regionSize)));
    }
    for (const chunk of tiles) {
      const x = (chunk.x * 32 - camera.x) * camera.zoom + bounds.width / 2;
      const y = (chunk.z * 32 - camera.z) * camera.zoom + bounds.height / 2, size = 32 * camera.zoom;
      if (x + size < 0 || y + size < 0 || x > bounds.width || y > bounds.height) continue;
      ctx.drawImage(chunk.image, Math.floor(x), Math.floor(y), Math.ceil(size), Math.ceil(size));
    }
  }, [tiles, camera, size]);
  return <canvas ref={ref} class="global-map-terrain" aria-label="Vintage Story explored terrain" />;
}

function screenshotProject(point, view, height) {
  if (!finitePoint(point) || !view?.world || !view.here || !view.east100 || !view.south100) return null;
  const dx = (point.x - view.world.x) / 100, dz = (point.z - view.world.z) / 100;
  return { x: (view.here[0] + dx * (view.east100[0] - view.here[0]) + dz * (view.south100[0] - view.here[0])) * 1000,
    y: (view.here[1] + dx * (view.east100[1] - view.here[1]) + dz * (view.south100[1] - view.here[1])) * height };
}

function ScreenshotMap({ bots, detailed }) {
  const source = bots.filter(bot => bot.mapImage?.at).sort((a, b) => b.mapImage.at - a.mapImage.at)[0];
  if (!source) return <div class="map-empty"><span>Waiting for explored terrain</span><small>Open the World Map once on a reporting Seraph.</small></div>;
  const height = 1000 * source.mapImage.height / source.mapImage.width;
  const agents = !source.mapImage.view ? [] : bots.map((bot, index) => {
    const state = stateOf(bot), trail = positionHistory(bot).filter(point => finitePoint(point) && (point.dimension ?? 0) === (state.position?.dimension ?? 0));
    const current = finitePoint(state.position) ? state.position : trail.at(-1);
    return current ? { bot, index, state, current: screenshotProject(current, source.mapImage.view, height) } : null;
  }).filter(Boolean);
  return <div class={`world-map native-world-map ${detailed ? 'detailed-map' : ''}`} style={{ aspectRatio: `${source.mapImage.width} / ${source.mapImage.height}` }}>
    <img src={`/api/map-image/${encodeURIComponent(source.id)}?v=${source.mapImage.at}`} alt={`${source.id}'s Vintage Story World Map`} />
    <svg viewBox={`0 0 1000 ${height}`} aria-label="Live Seraph positions">{agents.map(({ bot, index, state, current }) => current &&
      <a key={bot.id} href={`/bots/${encodeURIComponent(bot.id)}`} class={`map-agent agent-${index % 6}`}>
        <g transform={`translate(${current.x} ${current.y}) rotate(${state.orientation?.yawDegrees ?? 0})`} class="agent-marker"><circle r="9" /><path d="M0 -13 L6 3 L0 1 L-6 3 Z" /></g>
        <text x={current.x + 13} y={current.y - 10} class="map-label">{bot.id}</text>
      </a>)}</svg>
    <div class="native-map-source">Screenshot fallback · {source.id}</div>
  </div>;
}

const fitCamera = (bounds, size) => bounds && size.width ? { x: (bounds.x1 + bounds.x2) / 2, z: (bounds.z1 + bounds.z2) / 2,
  zoom: Math.max(.025, Math.min(8, Math.min(size.width / Math.max(32, bounds.x2 - bounds.x1), size.height / Math.max(32, bounds.z2 - bounds.z1)) * .9)) } : null;
const screenPoint = (point, camera, size) => finitePoint(point) && camera ? { x: (point.x - camera.x) * camera.zoom + size.width / 2,
  y: (point.z - camera.z) * camera.zoom + size.height / 2 } : null;
const shown = (point, size) => point && point.x > -40 && point.y > -40 && point.x < size.width + 40 && point.y < size.height + 40;

function GlobalMap({ bots, world, bot, detailed }) {
  const revision = Math.max(...bots.filter(item => item.nativeMap?.world === world).map(item => item.nativeMap.revision || item.nativeMap.at), 0);
  const [map, setMap] = useState(null), [chunks, setChunks] = useState([]), [error, setError] = useState(null);
  const [size, setSize] = useState({ width: 960, height: 540, ratio: 1 }), [camera, setCamera] = useState(null);
  const drag = useRef(null), frame = useRef(null), source = useRef(null);
  useEffect(() => { let active = true; setError(null); loadManifest(world, bot, revision).then(value => { if (active) {
      const key = `${world}:${bot ?? '*'}`;
      if (source.current !== key) { source.current = key; setChunks([]); setCamera(null); }
      setMap(value);
    } })
    .catch(reason => { if (active) setError(reason.message); }); return () => { active = false; }; }, [world, bot, revision]);
  useEffect(() => { if (!camera && map?.bounds && size.width) setCamera(fitCamera(map.bounds, size)); }, [map, size.width, size.height, camera]);
  const visibleRegions = useMemo(() => {
    if (!map || !camera) return [];
    const pad = 256, halfWidth = size.width / camera.zoom / 2, halfHeight = size.height / camera.zoom / 2;
    const x1 = Math.floor((camera.x - halfWidth - pad) / 256), x2 = Math.floor((camera.x + halfWidth + pad) / 256);
    const z1 = Math.floor((camera.z - halfHeight - pad) / 256), z2 = Math.floor((camera.z + halfHeight + pad) / 256);
    return map.regions.filter(([x, z]) => x >= x1 && x <= x2 && z >= z1 && z <= z2)
      .sort((a, b) => Math.hypot(a[0] * 256 + 128 - camera.x, a[1] * 256 + 128 - camera.z) -
        Math.hypot(b[0] * 256 + 128 - camera.x, b[1] * 256 + 128 - camera.z)).slice(0, 96);
  }, [map, camera, size.width, size.height]);
  const visibleKey = visibleRegions.map(([x, z]) => `${x}:${z}`).join('|');
  useEffect(() => {
    if (!visibleRegions.length) { setChunks([]); return; }
    let active = true;
    Promise.all(visibleRegions.map(([x, z]) => loadRegion(world, bot, revision, x, z))).then(regions => {
      if (active) setChunks(regions.flat());
    }).catch(reason => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [world, bot, revision, visibleKey]);
  const resize = useCallback(next => setSize(prior => prior.width === next.width && prior.height === next.height && prior.ratio === next.ratio ? prior : next), []);
  const move = event => {
    if (!drag.current || !camera) return;
    setCamera({ ...drag.current.camera, x: drag.current.camera.x - (event.clientX - drag.current.x) / camera.zoom,
      z: drag.current.camera.z - (event.clientY - drag.current.y) / camera.zoom });
  };
  const zoom = (factor, px = size.width / 2, py = size.height / 2) => setCamera(current => {
    if (!current) return current;
    const next = Math.max(.025, Math.min(16, current.zoom * factor));
    const x = current.x + (px - size.width / 2) / current.zoom, z = current.z + (py - size.height / 2) / current.zoom;
    return { x: x - (px - size.width / 2) / next, z: z - (py - size.height / 2) / next, zoom: next };
  });
  const players = useMemo(() => {
    const rows = new Map();
    for (const source of bots.filter(item => item.nativeMap?.world === world).sort((a, b) => a.nativeMap.at - b.nativeMap.at))
      for (const player of source.nativeMap.players ?? []) rows.set(player.name, player);
    return [...rows.values()].filter(player => !bots.some(item => item.id.toLowerCase() === player.name.toLowerCase()));
  }, [bots, world]);
  const agents = useMemo(() => bots.filter(item => item.nativeMap?.world === world).map((item, index) => {
    const state = stateOf(item), current = state.position, target = targetOf(item), dimension = current?.dimension ?? 0;
    return finitePoint(current) && dimension === 0 ? { bot: item, index, state, current: screenPoint(current, camera, size), target: screenPoint(target, camera, size),
      trails: contiguousTrails(positionHistory(item).filter(point => (point.dimension ?? 0) === dimension)).map(trail => trail.map(point => screenPoint(point, camera, size)).filter(Boolean)) } : null;
  }).filter(Boolean), [bots, world, camera, size]);
  const terrainMap = useMemo(() => map ? { ...map, chunks } : null, [map, chunks]);
  if (error) return <div class="map-empty"><span>Could not load the global map</span><small>{error}</small></div>;
  if (!map || !camera) return <div class="map-empty"><span>Loading explored terrain</span><small>Combining native map chunks from reporting Seraphs.</small></div>;
  const scaleBlocks = Math.max(1, Math.round(120 / camera.zoom));
  return <div ref={frame} class={`world-map global-world-map ${detailed ? 'detailed-map' : ''}`}
    onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, camera }; }}
    onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
    onWheel={event => { event.preventDefault(); const bounds = frame.current.getBoundingClientRect(); zoom(Math.exp(-event.deltaY * .0015), event.clientX - bounds.left, event.clientY - bounds.top); }}>
    <Terrain map={terrainMap} camera={camera} onSize={resize} size={size} />
    <svg viewBox={`0 0 ${size.width} ${size.height}`} aria-label="Players, Seraphs, trails, and objectives">
      {agents.map(({ bot: item, index, state, current, target, trails }) => <g key={item.id} class={`map-agent agent-${index % 6}`}>
        {trails.map((trail, trailIndex) => trail.length > 1 && <g key={trailIndex}><polyline points={trail.map(p => `${p.x},${p.y}`).join(' ')} class="map-trail map-trail-shadow" />
          <polyline points={trail.map(p => `${p.x},${p.y}`).join(' ')} class="map-trail" /></g>)}
        {shown(current, size) && shown(target, size) && <><line x1={current.x} y1={current.y} x2={target.x} y2={target.y} class="target-line" />
          <g transform={`translate(${target.x} ${target.y})`} class="target-marker"><circle r="5" /><path d="M-9 0H9M0-9V9" /></g></>}
        {shown(current, size) && <a href={`/bots/${encodeURIComponent(item.id)}`}><g transform={`translate(${current.x} ${current.y}) rotate(${state.orientation?.yawDegrees ?? 0})`} class="agent-marker">
          <circle r="9" /><path d="M0 -13 L6 3 L0 1 L-6 3 Z" /></g><text x={current.x + 13} y={current.y - 10} class="map-label">{item.id}</text></a>}
      </g>)}
      {players.map(player => { const point = screenPoint(player, camera, size); return shown(point, size) && <g key={player.name} class="world-player" transform={`translate(${point.x} ${point.y})`}>
        <circle r="7" /><path d="M0 -10 L5 3 L0 1 L-5 3 Z" transform={`rotate(${player.yawDegrees ?? 0})`} /><text x="11" y="-8">{player.name}</text></g>; })}
    </svg>
    <div class="native-map-source">{bot ? `${bot}'s explored map` : `${map.count.toLocaleString()} chunks · ${bots.filter(item => item.nativeMap?.world === world).length} sources`}</div>
    <div class="map-controls" onPointerDown={event => event.stopPropagation()}><button onClick={() => zoom(1.5)} aria-label="Zoom in">+</button><button onClick={() => zoom(1 / 1.5)} aria-label="Zoom out">−</button>
      <button onClick={() => setCamera(fitCamera(map.bounds, size))}>Fit</button></div>
    <div class="map-scale"><i style={{ width: `${scaleBlocks * camera.zoom}px` }} />{scaleBlocks.toLocaleString()} blocks</div>
  </div>;
}

export function WorldMap({ bots, detailed = false }) {
  const sources = bots.filter(bot => bot.nativeMap?.world).sort((a, b) => b.nativeMap.at - a.nativeMap.at);
  const worlds = [...new Set(sources.map(bot => bot.nativeMap.world))], [selected, setSelected] = useState(null);
  useEffect(() => { if (!worlds.includes(selected)) setSelected(worlds[0] ?? null); }, [worlds.join('|'), selected]);
  const world = worlds.includes(selected) ? selected : worlds[0], bot = detailed && bots.length === 1 ? bots[0].id : null;
  if (!world) return <ScreenshotMap bots={bots} detailed={detailed} />;
  return <div class="global-map-wrap"><GlobalMap bots={bots} world={world} bot={bot} detailed={detailed} />
    {worlds.length > 1 && <div class="map-source-picker world-picker">{worlds.map(item => <button key={item} class={item === world ? 'selected' : ''}
      onClick={() => setSelected(item)}>World {item.slice(0, 8)}</button>)}</div>}</div>;
}
