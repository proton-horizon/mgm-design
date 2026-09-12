import type { PlacedFrame, View } from './canvas-math';

export type ViewportSize = { width: number; height: number };
/** Tests intersection in CSS screen coordinates, without preloading outside the viewport. */
export function frameIntersectsViewport(frame: PlacedFrame, view: View, size: ViewportSize) {
  return (
    size.width > 0 &&
    size.height > 0 &&
    (frame.x + frame.width) * view.scale + view.x > 0 &&
    frame.x * view.scale + view.x < size.width &&
    (frame.y + frame.height) * view.scale + view.y > 0 &&
    frame.y * view.scale + view.y < size.height
  );
}
