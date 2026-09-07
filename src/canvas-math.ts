import type { Frame } from './types';
export type View = { x: number; y: number; scale: number };
export type PlacedFrame = Frame & { x: number; y: number };
export const clampScale = (scale: number) => Math.max(0.08, Math.min(3, scale));
export function placeFrames(frames: Frame[]): PlacedFrame[] {
  let nextX = 0;
  return frames.map((frame) => {
    const x = frame.x ?? nextX;
    nextX = x + frame.width + 80;
    return { ...frame, x, y: frame.y ?? 0 };
  });
}
export function bounds(frames: PlacedFrame[]) {
  if (!frames.length) return { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.min(...frames.map((f) => f.x));
  const y = Math.min(...frames.map((f) => f.y)) - 42;
  return {
    x,
    y,
    width: Math.max(...frames.map((f) => f.x + f.width)) - x,
    height: Math.max(...frames.map((f) => f.y + f.height)) - y,
  };
}
export function fitView(frames: PlacedFrame[], width: number, height: number): View {
  const box = bounds(frames);
  const scale = clampScale(Math.min((width - 96) / box.width, (height - 140) / box.height, 1));
  return {
    x: (width - box.width * scale) / 2 - box.x * scale,
    y: (height - box.height * scale) / 2 - box.y * scale - 12,
    scale,
  };
}
/** Zoom keeps the world coordinate beneath the gesture's focal point stationary. */
export function zoomAt(view: View, scale: number, x: number, y: number): View {
  const next = clampScale(scale);
  const ratio = next / view.scale;
  return { scale: next, x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio };
}
