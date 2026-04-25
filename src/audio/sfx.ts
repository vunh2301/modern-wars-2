/**
 * SFX bus. SPEC Section 20.5 + Section 13.5 rate limiting.
 *
 * - Capture chime: 220Hz → 440Hz pitch sweep, low-pass filter, 200ms.
 *   Token-bucket rate limit 5/sec real-time (Section 13.5) — drops excess.
 * - Win fanfare: 4-note arpeggio C-E-G-C (rate-limit exempt).
 * - Battle hit: subtle white noise burst (rate-limited 5/sec).
 *
 * All SFX no-op if `ensureAudio()` hasn't been called yet (first gesture).
 */
import { ensureAudio, getTone } from './engine';

const CAPTURE_RATE_BUCKET_SIZE = 5;
const RATE_REFILL_PER_SEC = 5;
let captureTokens = CAPTURE_RATE_BUCKET_SIZE;
let lastRefillMs = performance.now();

function tryConsumeToken(): boolean {
  const now = performance.now();
  const dt = now - lastRefillMs;
  const refill = (dt / 1000) * RATE_REFILL_PER_SEC;
  captureTokens = Math.min(CAPTURE_RATE_BUCKET_SIZE, captureTokens + refill);
  lastRefillMs = now;
  if (captureTokens >= 1) {
    captureTokens -= 1;
    return true;
  }
  return false;
}

export function playCapture(): void {
  if (!tryConsumeToken()) return;
  const t = getTone();
  if (!t) return;
  try {
    const synth = new t.Synth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.005, decay: 0.05, sustain: 0.1, release: 0.15 },
    }).toDestination();
    const now = t.now();
    synth.frequency.setValueAtTime(220, now);
    synth.frequency.exponentialRampToValueAtTime(440, now + 0.18);
    synth.triggerAttackRelease(220, 0.2);
    setTimeout(() => synth.dispose(), 400);
  } catch (err) {
    console.warn('[sfx] capture chime failed', err);
  }
}

export function playWinFanfare(): void {
  const t = getTone();
  if (!t) return;
  try {
    const synth = new t.PolySynth(t.Synth).toDestination();
    const now = t.now();
    const notes = ['C5', 'E5', 'G5', 'C6'];
    notes.forEach((n, i) => synth.triggerAttackRelease(n, '8n', now + i * 0.18));
    setTimeout(() => synth.dispose(), 1500);
  } catch (err) {
    console.warn('[sfx] win fanfare failed', err);
  }
}

export function playBattleHit(): void {
  if (!tryConsumeToken()) return;
  const t = getTone();
  if (!t) return;
  try {
    const noise = new t.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.05 },
      volume: -28,
    }).toDestination();
    noise.triggerAttackRelease(0.05);
    setTimeout(() => noise.dispose(), 200);
  } catch (err) {
    console.warn('[sfx] battle hit failed', err);
  }
}

/** Initialize SFX bus on first audio unlock. */
export async function unlockSfx(): Promise<void> {
  await ensureAudio();
}
