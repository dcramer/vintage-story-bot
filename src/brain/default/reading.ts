// What the brain reads off a tick: the parts of the mod's replies it looks at.
// Everything optional but the body's place and pulse. Each entry point narrows
// the loose runtime reply to these once, so a misspelled field fails here
// instead of silently reading nothing mid-game.
export type BrainPoint = { x: number; y: number; z: number };
export type BrainState = {
  position: BrainPoint;
  alive: boolean;
  orientation?: { yawDegrees?: number };
  motion?: { swimming?: boolean; feetInLiquid?: boolean; onGround?: boolean };
  vitals?: {
    health?: { current?: number; max?: number };
    hunger?: { current?: number; max?: number };
    oxygen?: { current?: number; max?: number };
  };
  controlReady?: boolean;
  capabilities?: string[];
  life?: { deathId?: string | null; canRespawn?: boolean };
  condition?: { temporalStorm?: { phase?: string } };
  activeSlot?: number;
  nearbyEntities?: { code?: string; point?: BrainPoint; distance?: number; how?: string; at?: number }[];
};
export type BrainSlot = {
  inventory?: string;
  slot?: number;
  code?: string | null;
  quantity?: number;
  tool?: string;
  durability?: number;
  bag?: boolean;
  nutrition?: unknown;
  freshness?: unknown;
};
export type BrainEvent = {
  id?: number;
  at?: number;
  type?: string;
  text?: string;
  health?: number;
  kind?: string;
  code?: string;
  key?: string;
  point?: BrainPoint;
};
export type BrainBlock = { code?: string | null; boxes: { length: number }; hazard?: unknown };
export type BrainSeenCell = { x: number; y: number; z: number; code?: string | null; hazard?: unknown };
export type BrainTerrain = {
  get?: (x: number, y: number, z: number) => BrainBlock | null | undefined;
  cells?: Map<string, BrainSeenCell>;
};
