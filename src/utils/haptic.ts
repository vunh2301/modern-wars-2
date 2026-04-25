/** Haptic feedback wrapper. SPEC Section 9 Phase 5 deliverable. */
export function vibrateShort(): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(10);
    }
  } catch {
    // Silently ignore — Safari iOS doesn't expose vibrate.
  }
}
