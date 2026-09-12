import type { PlacedFrame, View } from './canvas-math';

export type ViewportSize = { width: number; height: number };
export const PREVIEW_MIN_SCALE = 0.25;
export const PREVIEW_SETTLE_MS = 180;
const MAX_LIVE_FRAMES = 2;
const MAX_FRAME_PIXELS = 4_000_000;

/** Tests intersection in CSS screen coordinates, without preloading outside the viewport. */
export function frameIntersectsViewport(frame: PlacedFrame, view: View, size: ViewportSize) {
  return (
    (frame.x + frame.width) * view.scale + view.x > 0 &&
    frame.x * view.scale + view.x < size.width &&
    (frame.y + frame.height) * view.scale + view.y > 0 &&
    frame.y * view.scale + view.y < size.height
  );
}

/** Chooses at most two visible live documents at readable zoom. Prefers the selected frame,
 * then distance to the viewport center. The unscaled area budget allows one oversized frame
 * alone so every supported frame remains viewable; it is not a bound on a mock's own memory. */
export function selectLiveFrames(
  frames: PlacedFrame[],
  view: View,
  size: ViewportSize,
  selected: string | null,
): Set<string> {
  if (view.scale < PREVIEW_MIN_SCALE || size.width <= 0 || size.height <= 0) return new Set();
  const distance = (frame: PlacedFrame) =>
    Math.hypot(
      (frame.x + frame.width / 2) * view.scale + view.x - size.width / 2,
      (frame.y + frame.height / 2) * view.scale + view.y - size.height / 2,
    );
  const candidates = frames
    .filter((frame) => frameIntersectsViewport(frame, view, size))
    .sort(
      (a, b) => Number(b.id === selected) - Number(a.id === selected) || distance(a) - distance(b),
    );
  const result = new Set<string>();
  let pixels = 0;
  for (const frame of candidates) {
    const area = frame.width * frame.height;
    if (result.size && pixels + area > MAX_FRAME_PIXELS) continue;
    result.add(frame.id);
    pixels += area;
    if (result.size === MAX_LIVE_FRAMES || pixels >= MAX_FRAME_PIXELS) break;
  }
  return result;
}
