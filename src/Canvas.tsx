import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Hand, Minus, MousePointer2, Plus, Scan, X } from 'lucide-react';
import type { Board } from './types';
import { bounds, fitView, placeFrames, zoomAt, type View } from './canvas-math';
import { useDialog } from './useDialog';
import { frameIntersectsViewport } from './frame-visibility';

export default function Canvas({ board }: { board: Board }) {
  const frames = useMemo(() => placeFrames(board.frames), [board.frames]);
  const viewport = useRef<HTMLDivElement>(null);
  // No preview loads before the first measurement and fit, even if ResizeObserver is delayed.
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>({ x: 70, y: 100, scale: 0.7 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragged = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [interacting, setInteracting] = useState(false);
  const [pageVisible, setPageVisible] = useState(document.visibilityState !== 'hidden');
  useEffect(() => {
    const changed = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  const interactionDialog = useDialog(interacting);
  const [windowSize, setWindowSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  useEffect(() => {
    const resize = () => setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const fit = useCallback(() => {
    const el = viewport.current;
    if (el) setView(fitView(frames, el.clientWidth, el.clientHeight));
  }, [frames]);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    let first = true;
    const observer = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
      if (first) {
        fit();
        first = false;
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1;
      if (event.ctrlKey || event.metaKey)
        setView((v) =>
          zoomAt(
            v,
            v.scale * Math.exp(-event.deltaY * unit * 0.01),
            event.clientX - rect.left,
            event.clientY - rect.top,
          ),
        );
      else setView((v) => ({ ...v, x: v.x - event.deltaX * unit, y: v.y - event.deltaY * unit }));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  const zoom = (factor: number) =>
    setView((v) => zoomAt(v, v.scale * factor, size.width / 2, size.height / 2));
  const focus = (id: string) => {
    setSelected(id);
    const frame = frames.find((f) => f.id === id);
    if (frame) setView(fitView([frame], size.width, size.height));
  };
  const active = frames.find((f) => f.id === selected);
  const box = bounds(frames);
  const miniScale = Math.min(138 / box.width, 72 / box.height);
  useEffect(() => {
    if (!interacting) viewport.current?.focus({ preventScroll: true });
  }, [interacting]);

  if (!frames.length)
    return (
      <div className="empty-state">
        <Scan size={32} />
        <h2>A little room for ideas</h2>
        <p>This board has no screens yet. They’ll appear here when its designs are published.</p>
      </div>
    );
  return (
    <div className="canvas-container">
      <div
        ref={viewport}
        className={`canvas ${dragging ? 'dragging' : ''}`}
        tabIndex={0}
        aria-label={`${board.name} design canvas. Drag to pan, pinch to zoom. Press F to fit all screens.`}
        style={{
          backgroundPosition: `${view.x}px ${view.y}px`,
          backgroundSize: `${Math.max(14, 24 * view.scale)}px ${Math.max(14, 24 * view.scale)}px`,
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (
            [
              '+',
              '=',
              '-',
              '0',
              '1',
              'f',
              'F',
              'Escape',
              'ArrowLeft',
              'ArrowRight',
              'ArrowUp',
              'ArrowDown',
            ].includes(e.key)
          )
            e.preventDefault();
          if (e.key === '+' || e.key === '=') zoom(1.2);
          if (e.key === '-') zoom(1 / 1.2);
          if (e.key === 'f' || e.key === 'F' || e.key === '0') fit();
          if (e.key === '1') setView((v) => zoomAt(v, 1, size.width / 2, size.height / 2));
          if (e.key === 'Escape') setSelected(null);
          const delta: Record<string, [number, number]> = {
            ArrowLeft: [60, 0],
            ArrowRight: [-60, 0],
            ArrowUp: [0, 60],
            ArrowDown: [0, -60],
          };
          if (delta[e.key])
            setView((v) => ({ ...v, x: v.x + delta[e.key][0], y: v.y + delta[e.key][1] }));
        }}
        onPointerDown={(e) => {
          if (e.button !== 0 && e.button !== 1) return;
          e.currentTarget.focus({ preventScroll: true });
          e.currentTarget.setPointerCapture(e.pointerId);
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          dragged.current = false;
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const previous = pointers.current.get(e.pointerId);
          if (!previous) return;
          const before = [...pointers.current.values()];
          const dx = e.clientX - previous.x;
          const dy = e.clientY - previous.y;
          if (Math.abs(dx) + Math.abs(dy) > 2) dragged.current = true;
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (before.length === 2) {
            const after = [...pointers.current.values()];
            const distance = (p: typeof before) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
            const rect = e.currentTarget.getBoundingClientRect();
            const bx = (before[0].x + before[1].x) / 2 - rect.left;
            const by = (before[0].y + before[1].y) / 2 - rect.top;
            const ax = (after[0].x + after[1].x) / 2 - rect.left;
            const ay = (after[0].y + after[1].y) / 2 - rect.top;
            setView((v) => {
              const next = zoomAt(
                v,
                (v.scale * distance(after)) / Math.max(distance(before), 1),
                bx,
                by,
              );
              return { ...next, x: next.x + ax - bx, y: next.y + ay - by };
            });
          } else setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
          if (!pointers.current.size) setDragging(false);
          if (!dragged.current) {
            const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-frame]');
            setSelected(target?.getAttribute('data-frame') ?? null);
          }
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          if (!pointers.current.size) setDragging(false);
        }}
      >
        <div
          className="world"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          {frames.map((frame, index) => {
            return (
              <div
                key={frame.id}
                data-frame={frame.id}
                className={`design-frame ${selected === frame.id ? 'selected' : ''}`}
                style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
                onDoubleClick={() => focus(frame.id)}
              >
                <div className="frame-label">
                  <span>
                    {String(index + 1).padStart(2, '0')} <b>{frame.name}</b>
                  </span>
                  <span>
                    {frame.width} × {frame.height}
                  </span>
                </div>
                {pageVisible && frame.preview && frameIntersectsViewport(frame, view, size) ? (
                  <FramePreview key={frame.preview} src={frame.preview} name={frame.name} />
                ) : (
                  <div className="frame-placeholder">
                    <span>{frame.name}</span>
                    <small>Open this screen to explore</small>
                  </div>
                )}
                <div className="frame-shield" />
              </div>
            );
          })}
        </div>
      </div>
      <div className="canvas-note">
        <span className="tiny-dot" />
        {frames.length} screens
        <span className="note-divider" />
        Drag to pan · Pinch to zoom
      </div>
      <label className="screen-jump">
        <span>Jump to</span>
        <select
          aria-label="Jump to screen"
          value={selected ?? ''}
          onChange={(e) => {
            if (e.target.value) focus(e.target.value);
          }}
        >
          <option value="" disabled>
            Select a screen
          </option>
          {frames.map((frame) => (
            <option value={frame.id} key={frame.id}>
              {frame.name}
            </option>
          ))}
        </select>
      </label>
      {active && (
        <div className="selection-bar">
          <span>{active.name}</span>
          <button onClick={() => setInteracting(true)}>
            <MousePointer2 size={14} /> Interact
          </button>
          <button
            className="icon-button"
            aria-label="Deselect screen"
            onClick={() => setSelected(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <div className="canvas-toolbar" aria-label="Canvas controls">
        <button
          className="icon-button active-tool"
          title="Pan canvas"
          aria-label="Pan canvas"
          onClick={() => viewport.current?.focus()}
        >
          <Hand size={17} />
        </button>
        <span className="tool-divider" />
        <button
          className="icon-button"
          onClick={() => zoom(1 / 1.2)}
          title="Zoom out (−)"
          aria-label="Zoom out"
        >
          <Minus size={16} />
        </button>
        <button
          className="zoom-value"
          onClick={() => setView((v) => zoomAt(v, 1, size.width / 2, size.height / 2))}
          title="Actual size (1)"
        >
          {Math.round(view.scale * 100)}%
        </button>
        <button
          className="icon-button"
          onClick={() => zoom(1.2)}
          title="Zoom in (+)"
          aria-label="Zoom in"
        >
          <Plus size={16} />
        </button>
        <span className="tool-divider" />
        <button
          className="icon-button"
          onClick={fit}
          title="Fit all screens (F)"
          aria-label="Fit all screens"
        >
          <Scan size={18} />
        </button>
      </div>
      <div className="minimap" aria-label="Board overview">
        <svg
          viewBox="0 0 160 100"
          role="img"
          aria-label="Screen positions and current viewport"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const x = ((e.clientX - r.left) / r.width) * 160;
            const y = ((e.clientY - r.top) / r.height) * 100;
            setView((v) => ({
              ...v,
              x: size.width / 2 - ((x - 11) / miniScale + box.x) * v.scale,
              y: size.height / 2 - ((y - 14) / miniScale + box.y) * v.scale,
            }));
          }}
        >
          {frames.map((f) => (
            <rect
              key={f.id}
              x={11 + (f.x - box.x) * miniScale}
              y={14 + (f.y - box.y) * miniScale}
              width={f.width * miniScale}
              height={f.height * miniScale}
              rx="2"
              className="mini-frame"
            />
          ))}
          <rect
            x={11 + (-view.x / view.scale - box.x) * miniScale}
            y={14 + (-view.y / view.scale - box.y) * miniScale}
            width={(size.width / view.scale) * miniScale}
            height={(size.height / view.scale) * miniScale}
            rx="3"
            className="mini-viewport"
          />
        </svg>
      </div>
      {interacting && active && (
        <section
          ref={interactionDialog}
          className="interaction-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Interact with ${active.name}`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setInteracting(false);
          }}
        >
          <div className="interaction-header">
            <button className="plain-button" autoFocus onClick={() => setInteracting(false)}>
              <ArrowLeft size={16} /> Back to canvas
            </button>
            <span>{active.name}</span>
            <span className="interaction-mode">
              <MousePointer2 size={12} />
              Interact mode
            </span>
          </div>
          <div className="interaction-stage">
            {pageVisible && (
              <iframe
                title={`Interactive ${active.name}`}
                src={active.entry}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                style={{
                  width: active.width,
                  height: active.height,
                  transform: `translate(-50%, -50%) scale(${Math.min((windowSize.width - 32) / active.width, (windowSize.height - 133) / active.height, 1)})`,
                }}
              />
            )}
          </div>
          <div className="interaction-pager">
            <button
              className="icon-button"
              aria-label="Previous screen"
              disabled={frames.length < 2}
              onClick={() =>
                setSelected(
                  frames[
                    (frames.findIndex((f) => f.id === selected) - 1 + frames.length) % frames.length
                  ].id,
                )
              }
            >
              <ArrowLeft size={17} />
            </button>
            <span>
              {frames.findIndex((f) => f.id === selected) + 1} of {frames.length}
            </span>
            <button
              className="icon-button"
              aria-label="Next screen"
              disabled={frames.length < 2}
              onClick={() =>
                setSelected(
                  frames[(frames.findIndex((f) => f.id === selected) + 1) % frames.length].id,
                )
              }
            >
              <ArrowRight size={17} />
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function FramePreview({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <div className="frame-placeholder">
        <span>{name}</span>
        <small>Preview unavailable · Open this screen</small>
      </div>
    );
  return (
    <img
      className="frame-preview"
      src={src}
      alt={`${name} preview`}
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
