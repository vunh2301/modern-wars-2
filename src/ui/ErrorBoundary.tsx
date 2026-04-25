/**
 * React error boundary catching Pixi mount + UI render failures.
 * SPEC Section 13.4 + Section 15.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { palette } from '../style/palette';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, message: err.message || String(err) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info);
  }

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          position: 'absolute',
          inset: 0,
          background: palette.bgVoid,
          color: palette.textPrimary,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 32,
          fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
          textAlign: 'center',
          zIndex: 999,
        }}
      >
        <h1 style={{ color: palette.magenta, fontSize: '2rem', textShadow: `0 0 12px ${palette.magenta}`, marginBottom: 16 }}>
          ◆ FATAL ERROR
        </h1>
        <div style={{ color: palette.textMuted, marginBottom: 24, maxWidth: 480, fontSize: '0.85rem' }}>
          {this.state.message}
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            background: 'transparent',
            color: palette.cyan,
            border: `1px solid ${palette.cyan}`,
            padding: '8px 24px',
            fontFamily: 'inherit',
            cursor: 'pointer',
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
          }}
        >
          ↻ Reload
        </button>
      </div>
    );
  }
}
