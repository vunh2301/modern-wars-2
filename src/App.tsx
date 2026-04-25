import { PixiRoot } from './render/PixiRoot';
import { FpsOverlay } from './ui/FpsOverlay';
import { SpeedControl } from './ui/SpeedControl';

/**
 * Root layout. Phase 2 wires SpeedControl onto the HUD; sim runner is
 * created inside PixiRoot once `WorldData` is loaded.
 *
 * Phase 4 will add Leaderboard + BattleCounter + WinnerOverlay + Settings.
 */
export function App(): JSX.Element {
  return (
    <div className="app-root" style={{ width: '100%', height: '100%', position: 'relative' }}>
      <PixiRoot />
      <SpeedControl />
      <FpsOverlay />
    </div>
  );
}
