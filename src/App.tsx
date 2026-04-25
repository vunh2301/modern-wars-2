import { PixiRoot } from './render/PixiRoot';
import { FpsOverlay } from './ui/FpsOverlay';

/**
 * Root layout. Phase 0 placeholder — sole purpose is mounting Pixi + FPS overlay
 * to verify renderer reaches 60fps on an empty scene.
 *
 * Subsequent phases will add HUD (Section 20.4), leaderboard (Phase 4), settings, etc.
 */
export function App(): JSX.Element {
  return (
    <div className="app-root" style={{ width: '100%', height: '100%', position: 'relative' }}>
      <PixiRoot />
      <FpsOverlay />
    </div>
  );
}
