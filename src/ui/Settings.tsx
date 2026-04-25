/**
 * Settings panel modal. SPEC Section 20.4 (gear icon top-right).
 *
 * Phase 4 scope: bench mode toggle, audio toggle (Phase 5 wires actual audio),
 * RNG seed override, scanline overlay toggle.
 */
import { useState } from 'react';
import { useGameStore } from '../state/store';
import { palette } from '../style/palette';
import { ensureAudio, isAudioInitialized } from '../audio/engine';

export function Settings(): JSX.Element {
  const [open, setOpen] = useState(false);
  const seed = useGameStore((s) => s.rngSeed);
  const setRngSeed = useGameStore((s) => s.setRngSeed);
  const [draftSeed, setDraftSeed] = useState(seed);
  const [audioEnabled, setAudioEnabled] = useState(isAudioInitialized());

  const onAudioToggle = (next: boolean): void => {
    setAudioEnabled(next);
    if (next) {
      void ensureAudio();
    }
    // Note: disposeAudio invoked at unmount (Section 15.3); toggle off here
    // just stops emitting new SFX (caller-side gating).
  };
  const [scanlines, setScanlines] = useState(true);

  const applySeed = (): void => {
    if (draftSeed && draftSeed !== seed) {
      setRngSeed(draftSeed);
      // Hard reload so init() reseeds + re-rolls initial state deterministically.
      window.location.reload();
    }
  };

  const gearStyle: React.CSSProperties = {
    position: 'absolute',
    top: 8,
    right: 8,
    background: 'rgba(0, 12, 28, 0.85)',
    border: `1px solid ${palette.cyanDim}`,
    color: palette.cyan,
    width: 36,
    height: 36,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '0.85rem',
    zIndex: 9,
    backdropFilter: 'blur(8px)',
  };

  return (
    <>
      <button
        type="button"
        aria-label="Settings"
        onClick={() => setOpen((o) => !o)}
        style={gearStyle}
      >
        ⚙
      </button>
      {open && (
        <aside
          role="dialog"
          aria-label="Settings"
          style={{
            position: 'absolute',
            top: 50,
            right: 8,
            width: 280,
            background: palette.bgPanel,
            border: `1px solid ${palette.cyan}`,
            padding: 12,
            fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
            color: palette.textPrimary,
            fontSize: '0.75rem',
            zIndex: 11,
            boxShadow: `0 0 16px rgba(0, 229, 255, 0.3)`,
          }}
        >
          <div style={{ color: palette.cyan, marginBottom: 10, letterSpacing: '0.15em', textTransform: 'uppercase' }}>◆ Settings</div>

          <Toggle label="Audio" value={audioEnabled} onChange={onAudioToggle} />
          <Toggle label="Scanlines (FX)" value={scanlines} onChange={setScanlines} />

          <div style={{ marginTop: 12 }}>
            <label htmlFor="seed-input" style={{ display: 'block', color: palette.textMuted, fontSize: '0.65rem', marginBottom: 4, letterSpacing: '0.15em', textTransform: 'uppercase' }}>
              RNG Seed
            </label>
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                id="seed-input"
                value={draftSeed}
                onChange={(e) => setDraftSeed(e.target.value)}
                style={{
                  flex: 1,
                  background: palette.bgVoid,
                  color: palette.cyan,
                  border: `1px solid ${palette.cyanDim}`,
                  padding: '4px 6px',
                  fontFamily: 'inherit',
                  fontSize: '0.7rem',
                }}
              />
              <button
                type="button"
                onClick={applySeed}
                style={{
                  background: palette.cyan,
                  color: palette.bgVoid,
                  border: 'none',
                  padding: '4px 8px',
                  fontFamily: 'inherit',
                  fontSize: '0.7rem',
                  cursor: 'pointer',
                }}
                disabled={draftSeed === seed}
              >
                Apply
              </button>
            </div>
            <div style={{ color: palette.textDim, fontSize: '0.6rem', marginTop: 4 }}>
              Apply triggers reload (re-seeds initial state).
            </div>
          </div>
        </aside>
      )}
    </>
  );
}

function Toggle({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
      <span style={{ color: disabled ? palette.textDim : palette.textPrimary }}>{label}</span>
      <button
        type="button"
        onClick={() => !disabled && onChange(!value)}
        aria-pressed={value}
        disabled={disabled}
        style={{
          background: value ? palette.cyan : 'transparent',
          color: value ? palette.bgVoid : palette.cyanDim,
          border: `1px solid ${value ? palette.cyan : palette.cyanDim}`,
          padding: '2px 10px',
          fontFamily: 'inherit',
          fontSize: '0.7rem',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {value ? 'ON' : 'OFF'}
      </button>
    </div>
  );
}
