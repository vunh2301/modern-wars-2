/**
 * WebGL2 missing / unsupported browser fallback. SPEC Section 13.4.
 */
import { palette } from '../style/palette';

export function FatalError({ message }: { message: string }): JSX.Element {
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
        zIndex: 1000,
      }}
    >
      <h1 style={{ color: palette.magenta, fontSize: '2rem', textShadow: `0 0 12px ${palette.magenta}`, marginBottom: 16 }}>
        ◆ KHÔNG TƯƠNG THÍCH
      </h1>
      <div style={{ color: palette.textPrimary, fontSize: '1rem', marginBottom: 8 }}>{message}</div>
      <div style={{ color: palette.textMuted, fontSize: '0.8rem', marginTop: 16, maxWidth: 480 }}>
        Vui lòng cập nhật Safari ≥ 15 hoặc Chrome ≥ 56 (WebGL2 required, SPEC Section 13.4).
      </div>
    </div>
  );
}

/** WebGL2 capability detection. Returns null nếu supported, else error message. */
export function detectWebGL2Issue(): string | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) {
      return 'Trình duyệt không hỗ trợ WebGL2.';
    }
    return null;
  } catch (err) {
    return `WebGL2 detection failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
