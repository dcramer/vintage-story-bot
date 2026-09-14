// Removable cover on otherwise supported building ground.
export const surfaceCover = cell => /^game:(tallgrass-|snowlayer-)/.test(cell?.code ?? '');

export const shelterCover = (cell, height) =>
  (height === 0 && (surfaceCover(cell) || /^game:(flower-|fern-)/.test(cell?.code ?? ''))) || !!cell?.traits?.includes('leaves');

// Lake ice is a seasonal fluid-layer block, not a foundation. Its collision
// box looks exactly like permanent ground in winter, but it can thaw back to
// water underneath anything built on it.
export const supportedFloor = (cell, y) =>
  !!cell && !cell.hazard && !/(?:^|:)lakeice$/.test(cell.code ?? '') && cell.boxes.some(b => b[4] >= y && b[3] - b[0] >= 0.99 && b[5] - b[2] >= 0.99);
