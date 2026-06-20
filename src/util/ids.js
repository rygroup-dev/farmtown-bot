const rnd = () => Math.random().toString(36).slice(2, 8);
export const actionId = (action) => `${action}:${Date.now()}:${rnd()}`;
export const moveId = () => `move:${Date.now()}:${rnd()}`;
export const intentId = (action) => `intent:${action}:${Date.now()}:${rnd()}`;
export function clientDebug({ action, tool = 'hoe', seedId = 'none', tileX, tileY }) {
  return {
    interactionMode: 'farm',
    networkMode: 'socket',
    intent: intentId(action),
    selectedTool: tool,
    selectedSeedId: seedId,
    tile: `${tileX},${tileY}`,
  };
}
