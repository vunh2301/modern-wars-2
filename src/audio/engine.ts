/**
 * Audio engine with lazy Tone.js. SPEC Section 13.5 audio unlock + Section 20.5.
 *
 * Tone.js is dynamic-imported on first user gesture so it doesn't bloat
 * initial bundle (~70KB gz savings, Section 1 budget).
 *
 * Visibility hidden > 30s → suspend AudioContext (Section 15.3 lifecycle).
 */

let toneModule: typeof import('tone') | null = null;
let initialized = false;
let suspendTimer: number | null = null;

const SUSPEND_DELAY_MS = 30_000;

/** Lazy-load + start Tone audio context. Must be called from user gesture. */
export async function ensureAudio(): Promise<typeof import('tone') | null> {
  if (toneModule) return toneModule;
  try {
    const mod = await import('tone');
    await mod.start();
    toneModule = mod;
    initialized = true;
    setupVisibilityHandler();
    return mod;
  } catch (err) {
    console.warn('[audio] init failed, audio disabled', err);
    return null;
  }
}

export function getTone(): typeof import('tone') | null {
  return toneModule;
}

export function isAudioInitialized(): boolean {
  return initialized;
}

function setupVisibilityHandler(): void {
  document.addEventListener('visibilitychange', () => {
    const t = toneModule;
    if (!t) return;
    if (document.hidden) {
      // Suspend after delay (avoid spam toggling on quick hide/show).
      suspendTimer = window.setTimeout(() => {
        const ctx = t.context.rawContext as AudioContext;
        if (typeof ctx.suspend === 'function') void ctx.suspend().catch(() => {});
      }, SUSPEND_DELAY_MS);
    } else {
      if (suspendTimer != null) {
        window.clearTimeout(suspendTimer);
        suspendTimer = null;
      }
      const ctx = t.context.rawContext as AudioContext;
      if (typeof ctx.resume === 'function') void ctx.resume().catch(() => {});
    }
  });
}

/** Section 15.3: cleanup on app unmount. */
export function disposeAudio(): void {
  const t = toneModule;
  toneModule = null;
  initialized = false;
  if (suspendTimer != null) {
    window.clearTimeout(suspendTimer);
    suspendTimer = null;
  }
  if (!t) return;
  try {
    t.Transport.stop();
    t.Transport.cancel();
    const ctx = t.context.rawContext as AudioContext;
    if (typeof ctx.close === 'function') void ctx.close().catch(() => {});
  } catch (err) {
    console.warn('[audio] dispose error', err);
  }
}
