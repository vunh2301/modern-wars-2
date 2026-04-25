/**
 * Winner modal. SPEC Section 9 Phase 4 deliverable.
 * Shown khi state.winner !== null. Display winner code + faction color +
 * replay seed (Section 8.5 — deterministic reproduction).
 */
import { useGameStore } from '../state/store';
import { selectWinner } from '../state/selectors';
import { palette } from '../style/palette';

export function WinnerOverlay(): JSX.Element | null {
  const winner = useGameStore(selectWinner);
  const seed = useGameStore((s) => s.rngSeed);
  const tick = useGameStore((s) => s.tick);

  if (!winner) return null;

  const meta = useGameStore.getState().countries[winner];
  const winnerColor = meta ? '#00ff88' : palette.cyan;

  const reset = (): void => {
    // Hard reset by reload — Phase 8 will add proper reset action.
    window.location.reload();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Game over — winner declared"
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0, 4, 12, 0.85)',
        backdropFilter: 'blur(12px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
      }}
    >
      <div
        style={{
          background: palette.bgPanel,
          border: `2px solid ${winnerColor}`,
          padding: '32px 48px',
          minWidth: 320,
          textAlign: 'center',
          boxShadow: `0 0 32px ${winnerColor}`,
        }}
      >
        <div style={{ color: palette.cyanDim, fontSize: '0.7rem', letterSpacing: '0.3em', textTransform: 'uppercase', marginBottom: 8 }}>
          /* victor */
        </div>
        <h1 style={{ color: winnerColor, fontSize: '3rem', margin: '8px 0', textShadow: `0 0 16px ${winnerColor}` }}>
          {winner}
        </h1>
        <div style={{ color: palette.textPrimary, fontSize: '0.9rem', marginBottom: 24 }}>
          {useGameStore.getState().countries[winner]?.code === winner ? '★' : ''}{' '}
          {useGameStore.getState().countries[winner]?.code ?? winner} dominates
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.7rem', color: palette.textMuted, marginBottom: 24, alignItems: 'flex-start', textAlign: 'left' }}>
          <span>tick: <span style={{ color: palette.amber }}>{tick}</span></span>
          <span>seed: <span style={{ color: palette.cyan }}>{seed}</span></span>
        </div>
        <button
          type="button"
          onClick={reset}
          style={{
            background: 'transparent',
            color: palette.cyan,
            border: `1px solid ${palette.cyan}`,
            padding: '8px 24px',
            fontFamily: 'inherit',
            fontSize: '0.85rem',
            cursor: 'pointer',
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
          }}
        >
          ▶ New Game
        </button>
      </div>
    </div>
  );
}
