import { useEffect, useRef } from 'react';
/** Keeps keyboard focus inside the active dialog and restores its trigger on close. */
export function useDialog(active = true) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const previous = document.activeElement as HTMLElement | null;
    const selector =
      'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),iframe,[tabindex="0"]';
    const focusable = () =>
      [...el.querySelectorAll<HTMLElement>(selector)].filter(
        (node) => node.getClientRects().length,
      );
    focusable()[0]?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const nodes = focusable();
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    el.addEventListener('keydown', key);
    return () => {
      el.removeEventListener('keydown', key);
      previous?.focus({ preventScroll: true });
    };
  }, [active]);
  return ref;
}
