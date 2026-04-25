/**
 * `performance.measure` helpers. SPEC Section 7.3, Section 14.1 markers.
 */

export function mark(name: string): void {
  performance.mark(name);
}

export function measure(name: string, startMark: string, endMark: string): number {
  try {
    const m = performance.measure(name, startMark, endMark);
    return m.duration;
  } catch {
    return 0;
  }
}
