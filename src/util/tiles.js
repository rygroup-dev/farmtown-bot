const SIZE = 32, ORIGIN = 16;
export const tileToPixel = (tx, ty) => ({ x: tx*SIZE+ORIGIN, y: ty*SIZE+ORIGIN });
export const pixelToTile = (px, py) => ({ x: Math.round((px-ORIGIN)/SIZE), y: Math.round((py-ORIGIN)/SIZE) });
export function walkSteps(from, to, stride = SIZE) {
  const dx = to.x-from.x, dy = to.y-from.y;
  const dist = Math.hypot(dx, dy);
  const n = Math.max(1, Math.round(dist / stride));
  const pts = [];
  for (let i = 1; i <= n; i++) pts.push({ x: Math.round(from.x+dx*i/n), y: Math.round(from.y+dy*i/n) });
  return pts;
}
