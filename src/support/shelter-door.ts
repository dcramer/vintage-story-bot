export type ShelterDoorCell = { x: number; y: number; z: number };

// A crude door has an 8% chance to fall apart on every use. Two one-block
// wattle gates fill the existing two-high opening without that failure mode.
export const SHELTER_GATE = 'game:wattlegate-sticks-n-closed-left-free';
export const SHELTER_GATE_PREFIX = 'game:wattlegate-sticks-';

export const shelterDoorCells = (door: ShelterDoorCell) => [door, { ...door, y: door.y + 1 }];
export const shelterGate = (code: string | null | undefined) => !!code?.startsWith(SHELTER_GATE_PREFIX);
export const shelterGateState = (code: string | null | undefined, state: 'opened' | 'closed') => shelterGate(code) && code!.includes(`-${state}-`);
