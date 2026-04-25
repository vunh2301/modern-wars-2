/**
 * Boot lifecycle UI. SPEC Section 13.1.
 *
 * State machine: idle → fetchingAssets → parsingAssets → buildingScene → ready / error.
 * Phase 1b uses a single splash overlay with a step label + minimal % bar.
 * Subsequent phases (Phase 4) replace this with the proper Settings/HUD chrome.
 */
import { palette } from '../style/palette';

export type BootStep = 'idle' | 'fetching' | 'parsing' | 'composing' | 'building' | 'ready' | 'error';

const LABEL: Record<BootStep, string> = {
  idle: 'Awaiting Start',
  fetching: 'Fetching assets',
  parsing: 'Parsing world data',
  composing: 'Composing world graph',
  building: 'Building map scene',
  ready: 'Ready',
  error: 'Boot error',
};

export function Loading({
  step,
  progress,
  errorMessage,
  onRetry,
}: {
  step: BootStep;
  progress: number; // 0..1
  errorMessage?: string;
  onRetry?: () => void;
}): JSX.Element | null {
  if (step === 'ready') return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'absolute',
        inset: 0,
        background: palette.bgVoid,
        color: palette.textPrimary,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        gap: 16,
        fontFamily: 'var(--font-mono)',
      }}
    >
      <div
        style={{
          fontSize: 32,
          letterSpacing: '0.1em',
          color: palette.cyan,
          textShadow: `0 0 12px ${palette.cyan}`,
          textTransform: 'uppercase',
        }}
      >
        Modern Wars 2
      </div>
      <div
        style={{
          fontSize: 12,
          color: palette.textMuted,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
        }}
      >
        [ {LABEL[step]} ]
      </div>
      {step !== 'error' && (
        <div
          style={{
            width: 280,
            height: 4,
            border: `1px solid ${palette.cyanDim}`,
            background: palette.bgPanel,
          }}
        >
          <div
            style={{
              width: `${Math.max(2, Math.min(100, progress * 100))}%`,
              height: '100%',
              background: palette.cyan,
              boxShadow: `0 0 8px ${palette.cyan}`,
              transition: 'width 200ms linear',
            }}
          />
        </div>
      )}
      {step === 'error' && (
        <>
          <div
            style={{
              maxWidth: 480,
              padding: '12px 16px',
              border: `1px solid ${palette.magenta}`,
              background: palette.bgPanel,
              color: palette.magenta,
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            {errorMessage ?? 'Unknown error'}
          </div>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              style={{
                padding: '8px 24px',
                border: `1px solid ${palette.cyan}`,
                background: 'transparent',
                color: palette.cyan,
                fontFamily: 'inherit',
                fontSize: 12,
                letterSpacing: '0.15em',
                textTransform: 'uppercase',
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
          )}
        </>
      )}
    </div>
  );
}
