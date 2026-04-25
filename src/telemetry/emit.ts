/**
 * Telemetry emit hook. SPEC Section 14.4 — production wires `__mw2Telemetry` to
 * a backend (Vercel Analytics, Sentry, etc.). MVP just console.warn.
 */
import type { TelemetryEvent } from '../data/types';

declare global {
  interface Window {
    __mw2Telemetry?: { push?: (e: TelemetryEvent) => void };
  }
}

export function emit(event: TelemetryEvent): void {
  if (typeof window !== 'undefined' && window.__mw2Telemetry?.push) {
    window.__mw2Telemetry.push(event);
    return;
  }
  console.warn('[telemetry]', event);
}
