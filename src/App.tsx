import { PixiRoot } from './render/PixiRoot';
import { FpsOverlay } from './ui/FpsOverlay';
import { SpeedControl } from './ui/SpeedControl';
import { Leaderboard } from './ui/Leaderboard';
import { BattleCounter } from './ui/BattleCounter';
import { WinnerOverlay } from './ui/WinnerOverlay';
import { Settings } from './ui/Settings';

/**
 * Root layout. SPEC Section 20.4 mobile-first HUD.
 *
 * Layer order (z-stack):
 *  - Pixi canvas (background)
 *  - SpeedControl (top center)
 *  - Settings (top right)
 *  - Leaderboard (right side)
 *  - BattleCounter (bottom left)
 *  - FpsOverlay (top left)
 *  - WinnerOverlay (full-screen modal — only when winner)
 */
export function App(): JSX.Element {
  return (
    <div className="app-root" style={{ width: '100%', height: '100%', position: 'relative' }}>
      <PixiRoot />
      <SpeedControl />
      <Settings />
      <Leaderboard />
      <BattleCounter />
      <FpsOverlay />
      <WinnerOverlay />
    </div>
  );
}
