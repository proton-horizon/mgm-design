import { describe, expect, it } from 'vitest';
import { frameIntersectsViewport } from './frame-visibility';

const frame = { id: 'home', name: 'Home', entry: 'home.html', x: 0, y: 0, width: 390, height: 844 };
const size = { width: 390, height: 650 };
describe('frame image visibility', () => {
  it('uses scaled and translated bounds, including partial visibility', () => {
    expect(frameIntersectsViewport(frame, { x: -159, y: 0, scale: 0.41 }, size)).toBe(true);
    expect(frameIntersectsViewport(frame, { x: -160, y: 0, scale: 0.41 }, size)).toBe(false);
    expect(frameIntersectsViewport(frame, { x: 0, y: -844, scale: 1 }, size)).toBe(false);
    expect(frameIntersectsViewport(frame, { x: 390, y: 0, scale: 1 }, size)).toBe(false);
    expect(frameIntersectsViewport(frame, { x: 0, y: 650, scale: 1 }, size)).toBe(false);
  });
  it('does not load previews before the viewport is measured', () => {
    expect(
      frameIntersectsViewport(frame, { x: -100, y: -100, scale: 1 }, { width: 0, height: 0 }),
    ).toBe(false);
  });
});
