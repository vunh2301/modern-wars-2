import { useEffect, useRef, useState } from 'react';
import { palette } from '../style/palette';

/**
 * Top-left FPS counter overlay (SPEC Section 7.3, Section 8.1, Section 20.4 bench panel).
 * Phase 0: simple instantaneous + p50/p95 over last 600 frames using rAF.
 *
 * Subsequent phases: extend with bench panel JSON + p99 + memory line (Section 8.1).
 */
const SAMPLE_WINDOW = 600;

export function FpsOverlay(): JSX.Element {
  const samplesRef = useRef<number[]>([]);
  const lastRef = useRef<number>(performance.now());
  const rafRef = useRef<number>(0);
  const [fps, setFps] = useState({ now: 0, p50: 0, p95: 0 });

  useEffect(() => {
    const tick = (t: number) => {
      const dt = t - lastRef.current;
      lastRef.current = t;
      const samples = samplesRef.current;
      if (dt > 0) samples.push(dt);
      if (samples.length > SAMPLE_WINDOW) samples.shift();

      // Update display 4× per second to avoid React thrash
      if (samples.length % 15 === 0 && samples.length > 0) {
        const sorted = [...samples].sort((a, b) => a - b);
        const p50ms = sorted[Math.floor(sorted.length * 0.5)] ?? dt;
        const p95ms = sorted[Math.floor(sorted.length * 0.95)] ?? dt;
        setFps({
          now: dt > 0 ? Math.round(1000 / dt) : 0,
          p50: p50ms > 0 ? Math.round(1000 / p50ms) : 0,
          p95: p95ms > 0 ? Math.round(1000 / p95ms) : 0,
        });
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <div
      role="status"
      aria-live="off"
      style={{
        position: 'absolute',
        top: 8,
        left: 8,
        padding: '6px 10px',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        letterSpacing: '0.05em',
        color: palette.cyan,
        background: 'rgba(0, 8, 20, 0.6)',
        border: `1px solid ${palette.cyanDim}`,
        textShadow: `0 0 6px ${palette.cyan}`,
        boxShadow: `0 0 8px rgba(0, 229, 255, 0.25)`,
        pointerEvents: 'none',
        userSelect: 'none',
        zIndex: 10,
      }}
    >
      FPS {fps.now.toString().padStart(2, '0')}
      {' · '}P50 {fps.p50.toString().padStart(2, '0')}
      {' · '}P95 {fps.p95.toString().padStart(2, '0')}
    </div>
  );
}
