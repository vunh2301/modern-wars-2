/**
 * Subscribe to ownership changes; fire SFX + haptic on capture events.
 * SPEC Section 13.5 (audio rate limiting) + Section 20.5.
 *
 * Diffs `countries[code].ownerId` between store snapshots when
 * `ownershipVersion` bumps; fires `playCapture()` for each newly-flipped
 * country (rate-limited inside SFX module).
 */
import { useGameStore } from '../state/store';
import { selectOwnershipVersion } from '../state/selectors';
import { playCapture, playWinFanfare } from '../audio/sfx';
import { vibrateShort } from '../utils/haptic';

export function startCaptureSubscriber(): () => void {
  let prevOwners: Record<string, string> = snapshotOwners();
  let prevWinner: string | null = useGameStore.getState().winner;

  const unsub = useGameStore.subscribe((s, prev) => {
    // Win event
    if (s.winner !== null && prevWinner === null) {
      prevWinner = s.winner;
      playWinFanfare();
      vibrateShort();
    }

    if (selectOwnershipVersion(s) === selectOwnershipVersion(prev)) return;

    const next = snapshotOwners();
    let captureCount = 0;
    for (const code of Object.keys(next)) {
      if (prevOwners[code] !== next[code]) {
        captureCount += 1;
      }
    }
    prevOwners = next;
    if (captureCount > 0) {
      // Token bucket inside playCapture handles rate limit.
      playCapture();
      if (captureCount === 1) vibrateShort();
    }
  });

  return unsub;
}

function snapshotOwners(): Record<string, string> {
  const out: Record<string, string> = {};
  const countries = useGameStore.getState().countries;
  for (const code of Object.keys(countries)) {
    const c = countries[code];
    if (c) out[code] = c.ownerId;
  }
  return out;
}
