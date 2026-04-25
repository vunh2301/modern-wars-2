/**
 * Top-12 sides leaderboard. SPEC Section 9 Phase 4 + Section 4.2 selectors.
 *
 * Subscribes `sidesVersion` (NOT countries Record) — Section 4.2 selector
 * specificity rule. Debounced 100ms when speed > 8× to avoid React re-render
 * thrash at 256 ticks/s.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useGameStore } from '../state/store';
import { selectSidesVersion, selectSpeed, topSides } from '../state/selectors';
import type { SideDerived } from '../data/types';
import { palette } from '../style/palette';

const TOP_N = 12;
const DEBOUNCE_MS = 100;

export function Leaderboard(): JSX.Element {
  const sidesVersion = useGameStore(selectSidesVersion);
  const speed = useGameStore(selectSpeed);

  const [tick, setTick] = useState(0);
  const lastBumpRef = useRef(0);

  // Debounce re-render at high speed.
  useEffect(() => {
    if (speed <= 8) {
      setTick(sidesVersion);
      return;
    }
    const now = performance.now();
    const sinceLast = now - lastBumpRef.current;
    if (sinceLast >= DEBOUNCE_MS) {
      lastBumpRef.current = now;
      setTick(sidesVersion);
      return;
    }
    const t = window.setTimeout(() => {
      lastBumpRef.current = performance.now();
      setTick(sidesVersion);
    }, DEBOUNCE_MS - sinceLast);
    return () => window.clearTimeout(t);
  }, [sidesVersion, speed]);

  // Snapshot derived only when `tick` advances.
  const top = useMemo<SideDerived[]>(() => {
    void tick; // intentional dep — invalidate cache on version bump
    const sides = useGameStore.getState().sides;
    return topSides(sides, TOP_N);
  }, [tick]);

  // ownerId IS the country code that originally founded the side. Use it for display.
  const countries = useGameStore.getState().countries;

  return (
    <aside
      aria-live="polite"
      aria-label="Top sides leaderboard"
      style={{
        position: 'absolute',
        right: 8,
        top: 64,
        width: 220,
        background: 'rgba(0, 12, 28, 0.85)',
        backdropFilter: 'blur(8px)',
        border: `1px solid ${palette.cyanDim}`,
        padding: 10,
        fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
        fontSize: '0.7rem',
        color: palette.textPrimary,
        zIndex: 9,
      }}
    >
      <div style={{ color: palette.cyan, marginBottom: 6, letterSpacing: '0.15em', textTransform: 'uppercase' }}>
        ◆ Top {TOP_N}
      </div>
      <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {top.map((s, i) => {
          const meta = countries[s.ownerId];
          const isCapital = s.capitalCode != null;
          return (
            <li
              key={s.ownerId}
              style={{
                display: 'grid',
                gridTemplateColumns: '20px 36px 1fr auto',
                gap: 6,
                padding: '2px 0',
                borderBottom: `1px solid ${palette.bgPanelHover}`,
              }}
            >
              <span style={{ color: palette.textDim }}>{i + 1}</span>
              <span style={{ color: palette.cyan }}>{s.ownerId}</span>
              <span style={{ color: isCapital ? palette.amber : palette.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {meta ? `${s.territoryCodes.length} terr` : s.ownerId}
              </span>
              <span style={{ color: palette.emerald }}>{Math.round(s.totalTroops).toLocaleString()}</span>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
