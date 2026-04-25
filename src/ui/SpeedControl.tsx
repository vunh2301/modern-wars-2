/**
 * Pause + speed selector HUD. SPEC Section 9 Phase 2 deliverable + Section 20.4.
 *
 * Speed values: 1, 2, 4, 8, 16, 32, 64 (Section 4.2 GameSpeed type).
 * Keyboard: Space = pause, 1/2/4/8 = speed (Section 17 a11y).
 */
import { useEffect } from 'react';
import { useGameStore } from '../state/store';
import { selectPaused, selectSpeed } from '../state/selectors';
import type { GameSpeed } from '../data/types';
import { palette } from '../style/palette';

const SPEEDS: GameSpeed[] = [1, 2, 4, 8, 16, 32, 64];

export function SpeedControl(): JSX.Element {
  const paused = useGameStore(selectPaused);
  const speed = useGameStore(selectSpeed);
  const togglePause = useGameStore((s) => s.togglePause);
  const setSpeed = useGameStore((s) => s.setSpeed);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target && (e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePause();
      } else if (e.key && /^[12348]$/.test(e.key)) {
        const v = Number(e.key) as GameSpeed;
        if (SPEEDS.includes(v)) setSpeed(v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePause, setSpeed]);

  const btnStyle = (active: boolean): React.CSSProperties => ({
    background: active ? palette.cyan : 'transparent',
    color: active ? palette.bgVoid : palette.cyan,
    border: `1px solid ${palette.cyan}`,
    padding: '4px 8px',
    fontFamily: 'inherit',
    fontSize: '0.75rem',
    cursor: 'pointer',
    minWidth: 32,
    transition: 'all 0.1s',
  });

  return (
    <div
      role="toolbar"
      aria-label="Game speed"
      style={{
        position: 'absolute',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: 4,
        background: 'rgba(0, 12, 28, 0.85)',
        backdropFilter: 'blur(8px)',
        padding: 6,
        border: `1px solid ${palette.cyanDim}`,
        borderRadius: 2,
        zIndex: 10,
        fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
      }}
    >
      <button
        type="button"
        onClick={togglePause}
        style={btnStyle(paused)}
        aria-pressed={paused}
        title="Space"
      >
        {paused ? '▶ PLAY' : '❚❚ PAUSE'}
      </button>
      {SPEEDS.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => setSpeed(s)}
          style={btnStyle(s === speed)}
          aria-pressed={s === speed}
        >
          {s}×
        </button>
      ))}
    </div>
  );
}
