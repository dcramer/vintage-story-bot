// Human reference pace: how fast a competent player at full speed does the
// primitive things the bot also does. Segment analysis (per leg, per surface,
// per dig) compares measured bot rates against these to find gaps; whole-goal
// wall clock never does, it mixes search, interruption and luck with speed.
// Provenance per value: asset (game data), measured (session logs; the bot's
// inputs drive the same physics a human's do), estimate (human-factors guess).

// Locomotion: horizontal blocks/s. Measured steady-state over 8 sessions of
// nav frames (constant heading, no jump input): flat means |dy| under 0.6/s,
// hilly means a sustained climb or descent of 2+ blocks.
export const WALK_FLAT_BPS = 3; // measured: mode of 21.5k samples, 4s-sustained best 3.1
export const SPRINT_FLAT_BPS = 5; // measured: mode of 2.4k samples, 4-5s sustained 5.2-5.4
export const WALK_HILLY_BPS = 2; // measured: p90 of 700-900 climb/descent windows (p50 1.2)
export const SPRINT_HILLY_BPS = 3; // estimate: flat walk-to-sprint ratio on hilly; 6 samples only

// Forming: one aimed click per surplus (knap) or missing (clay) voxel. Counts
// are exact from the recipe assets; rate and setup are estimates.
export const FORM_CLICKS_PER_S = 3; // estimate: aimed clicks on distinct voxels
export const FORM_SETUP_MS = 5000; // estimate: equip, place surface, select recipe
// assets/survival/recipes/knapping/*.json: voxels to remove per output tool.
// Material changes nothing (flint and stone patterns match); one arrowhead
// surface yields 6 heads for its 64 clicks.
export const KNAP_CLICKS: Record<string, number> = {
  arrowhead: 64,
  axehead: 48,
  hoehead: 48,
  knifeblade: 77,
  shovelhead: 28,
  spearhead: 66,
};
// assets/survival/recipes/clayforming/*.json: voxels to fill per single
// recipe, keyed by the fragment its output codes share (four*/two* recipes
// multiply: four bowls fill 164 for the same output code).
export const CLAY_CLICKS: Record<string, number> = {
  'raw-anvil': 750,
  'raw-blade-falx': 349,
  'raw-bullets': 379,
  'raw-hammer': 348,
  'raw-helvehammer': 208,
  'raw-hoe': 368,
  'raw-lamellae': 257,
  'raw-pickaxe': 362,
  'raw-prospectingpick': 369,
  'raw-shovel': 338,
  'raw-axe': 334,
  bowl: 41,
  claypot: 161,
  crock: 99,
  crucible: 113,
  flowerpot: 156,
  ingotmold: 93,
  wateringcan: 301,
  storagevessel: 924,
  clayplanter: 496,
  jug: 180,
  'oillamp-genie': 47,
  'shingle-raw': 144,
  'claytile-raw-plain': 168,
  clayoven: 1748,
};

export const formExpectedMs = clicks => Math.round(FORM_SETUP_MS + (clicks / FORM_CLICKS_PER_S) * 1000);
// A knapped knife (77 clicks) is ~31s, a hatchet (48) ~21s; a clay bowl (41)
// ~19s, a pot (161) ~59s. Null when the output names no known recipe.
export function knapExpectedMs(output: string): number | null {
  const tool = output.replace(/^game:/, '').split('-')[0];
  return tool in KNAP_CLICKS ? formExpectedMs(KNAP_CLICKS[tool]) : null;
}
export function clayformExpectedMs(output: string): number | null {
  const key = Object.keys(CLAY_CLICKS)
    .sort((a, b) => b.length - a.length)
    .find(k => output.includes(k));
  return key ? formExpectedMs(CLAY_CLICKS[key]) : null;
}

// Digging: the game break time is identical for bot and human (the same held
// click), so the gap is overhead per block. Assets: blocktypes give resistance
// (soil 1.8, log 4.5, rock 8), itemtypes/tool give mining speed by material
// (stone shovel on soil 2.2, flint axe on wood 2.8, copper pickaxe on stone 4).
// Measured bot break plus roundtrips (digging to verifying, 8 sessions): grass,
// leaves and forest floor ~1s; soil 1-3s; sand 3-5s; log by hand ~30s.
export const DIG_HUMAN_OVERHEAD_MS = 1000; // estimate: aim plus verify by eye
// The bot's overhead per block lives in changeBlock: aim roundtrips plus a
// 1000ms stability wait (changedForMs) before a change counts as verified.
