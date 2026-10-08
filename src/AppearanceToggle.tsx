import { Moon, Sun } from 'lucide-react';
import type { Appearance } from './types';

export default function AppearanceToggle({
  appearance,
  onChange,
  compact = false,
}: {
  appearance: Appearance;
  onChange: (appearance: Appearance) => void;
  compact?: boolean;
}) {
  const next = appearance === 'dark' ? 'light' : 'dark';
  return (
    <button
      className={compact ? 'plain-button appearance-toggle' : 'sidebar-link'}
      aria-label={`Appearance: ${appearance}. Switch to ${next} appearance`}
      title={`Switch to ${next} appearance`}
      onClick={() => onChange(next)}
    >
      {appearance === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
      {compact
        ? appearance === 'dark'
          ? 'Dark'
          : 'Light'
        : appearance === 'dark'
          ? 'Dark appearance'
          : 'Light appearance'}
    </button>
  );
}
