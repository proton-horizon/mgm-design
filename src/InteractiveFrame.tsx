import { useCallback, useEffect, useRef } from 'react';
import type { Appearance, Frame } from './types';

/** Sends only the viewer's appearance to the opaque mock document; readiness never changes viewer state. */
export default function InteractiveFrame({
  frame,
  scale,
  appearance,
}: {
  frame: Frame;
  scale: number;
  appearance: Appearance;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const sendAppearance = useCallback(() => {
    // Sandboxed documents have opaque origins; this payload contains no credentials or capabilities.
    ref.current?.contentWindow?.postMessage(
      { type: 'mgm:appearance', version: 1, appearance },
      '*',
    );
  }, [appearance]);
  useEffect(() => {
    const ready = (event: MessageEvent) => {
      if (
        !ref.current?.contentWindow ||
        event.source !== ref.current.contentWindow ||
        event.origin !== 'null'
      )
        return;
      const data: unknown = event.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      const message = data as Record<string, unknown>;
      if (message.type === 'mgm:appearance:ready' && message.version === 1) sendAppearance();
    };
    window.addEventListener('message', ready);
    sendAppearance();
    return () => window.removeEventListener('message', ready);
  }, [sendAppearance]);
  return (
    <iframe
      ref={ref}
      title={`Interactive ${frame.name}`}
      src={frame.entry}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={sendAppearance}
      style={{
        colorScheme: appearance,
        width: frame.width,
        height: frame.height,
        transform: `translate(-50%, -50%) scale(${scale})`,
      }}
    />
  );
}
