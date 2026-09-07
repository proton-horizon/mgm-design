import { describe, expect, it } from 'vitest';
import { fitView, placeFrames, zoomAt } from './canvas-math';
describe('canvas geometry', () => {
  it('keeps focal content fixed across zoom and enforces limits', () => {
    const start = { x: -150, y: 60, scale: 0.5 };
    const next = zoomAt(start, 2, 320, 200);
    expect((320 - next.x) / next.scale).toBe((320 - start.x) / start.scale);
    expect((200 - next.y) / next.scale).toBe((200 - start.y) / start.scale);
    expect(zoomAt(start, 100, 0, 0).scale).toBe(3);
  });
  it('fits negative and irregular frame coordinates within viewport', () => {
    const frames = placeFrames([
      { id: 'a', name: 'a', entry: '', width: 390, height: 844, x: -500, y: -200 },
      { id: 'b', name: 'b', entry: '', width: 1200, height: 900, x: 100, y: 300 },
    ]);
    const view = fitView(frames, 1400, 1000);
    for (const f of frames) {
      expect(f.x * view.scale + view.x).toBeGreaterThanOrEqual(0);
      expect((f.x + f.width) * view.scale + view.x).toBeLessThanOrEqual(1400);
      expect((f.y + f.height) * view.scale + view.y).toBeLessThanOrEqual(1000);
    }
  });
});
