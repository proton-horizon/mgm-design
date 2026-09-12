import { describe, expect, it } from 'vitest';
import { fitView, placeFrames, type PlacedFrame } from './canvas-math';
import { frameIntersectsViewport, selectLiveFrames } from './preview-budget';
const size = { width: 1200, height: 800 };
const view = { x: 0, y: 0, scale: 1 };
function frame(id: string, x = 0, width = 390, height = 844): PlacedFrame {
  return { id, x, y: 0, width, height, name: id, entry: `/mock/${id}` };
}
describe('live preview budget', () => {
  it('opens a 75-screen overview without starting document runtimes', () => {
    const frames = placeFrames(
      Array.from({ length: 75 }, (_, i) => frame(String(i), (i % 8) * 470)).map((f, i) => ({
        ...f,
        y: Math.floor(i / 8) * 1000,
      })),
    );
    const phone = { width: 390, height: 650 };
    const fit = fitView(frames, phone.width, phone.height);
    expect(selectLiveFrames(frames, fit, phone, null).size).toBe(0);
  });
  it('caps overlapping visible frames and prioritizes a selected frame', () => {
    const frames = Array.from({ length: 200 }, (_, i) => frame(String(i)));
    const selected = selectLiveFrames(frames, view, size, '199');
    expect([...selected]).toEqual(['199', '0']);
  });
  it('loads nearest visible frames without an offscreen preload margin', () => {
    const frames = [
      frame('left', -391),
      frame('a', 0),
      frame('b', 405),
      frame('c', 810),
      frame('right', 1200),
    ];
    expect([...selectLiveFrames(frames, view, size, 'right')]).toEqual(['b', 'a']);
    expect(frameIntersectsViewport(frame('edge', -390), view, size)).toBe(false);
  });
  it('budgets original viewport area, even when CSS scaling makes documents tiny', () => {
    const frames = [frame('large', 0, 2000, 2000), frame('small', 100, 100, 100)];
    expect([...selectLiveFrames(frames, { ...view, scale: 0.25 }, size, 'large')]).toEqual([
      'large',
    ]);
    expect([...selectLiveFrames([frame('oversized', 0, 4096, 4096)], view, size, null)]).toEqual([
      'oversized',
    ]);
  });
  it('releases frames outside the new viewport and returns no work for zero size', () => {
    expect(selectLiveFrames([frame('a')], { ...view, x: -500 }, size, 'a').size).toBe(0);
    expect(selectLiveFrames([frame('a')], view, { width: 0, height: 0 }, null).size).toBe(0);
  });
});
