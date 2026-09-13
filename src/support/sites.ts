// Removable cover on otherwise supported building ground.
export const surfaceCover = cell => /^game:(tallgrass-|snowlayer-)/.test(cell?.code ?? '');

export const shelterCover = (cell, height) => (height === 0 && surfaceCover(cell)) || !!cell?.traits?.includes('leaves');

export const supportedFloor = (cell, y) => !!cell && !cell.hazard && cell.boxes.some(b => b[4] >= y && b[3] - b[0] >= 0.99 && b[5] - b[2] >= 0.99);
