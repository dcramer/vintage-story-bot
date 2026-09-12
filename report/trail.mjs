const respawnTimes = log => (log ?? []).filter(entry => entry?.topic === 'action' && entry.data?.action === 'respawn' && entry.data?.ok !== false && Number.isFinite(entry.at))
  .map(entry => entry.at).sort((a, b) => a - b);

export const trailWindowMs = 15 * 60 * 1000;
export const trailPointLimit = 180;

export function recentTrail(points, now = Date.now(), maxAgeMs = trailWindowMs, maxPoints = trailPointLimit) {
  const cutoff = now - maxAgeMs;
  return (points ?? []).filter(point => Number.isFinite(point?.at) && point.at >= cutoff).slice(-maxPoints);
}

export function trimTrail(points, now = Date.now(), maxAgeMs = trailWindowMs, maxPoints = trailPointLimit) {
  const recent = recentTrail(points, now, maxAgeMs, maxPoints);
  if (recent.length === points.length) return false;
  points.splice(0, points.length, ...recent);
  return true;
}

export function markRespawnBreaks(trail, log) {
  let changed = false;
  for (const at of respawnTimes(log)) {
    const point = trail.find(item => item.at >= at);
    if (point && point.discontinuity !== 'respawn') { point.discontinuity = 'respawn'; changed = true; }
  }
  return changed;
}

export function contiguousTrails(points, log) {
  const trails = [], respawns = respawnTimes(log);
  for (const point of points) {
    const trail = trails.at(-1), prior = trail?.at(-1);
    const respawned = point.discontinuity === 'respawn' || prior && respawns.some(at => at > prior.at && at <= point.at);
    if (!prior || respawned || point.dimension !== prior.dimension || Math.hypot(point.x - prior.x, point.z - prior.z) > 128) trails.push([point]);
    else trail.push(point);
  }
  return trails;
}
