/**
 * Battle count + sea invasion count. SPEC Section 9 Phase 4 deliverable.
 * Subscribes `battlesVersion` only.
 */
import { useGameStore } from '../state/store';
import { selectBattlesVersion, selectTick } from '../state/selectors';
import { palette } from '../style/palette';

export function BattleCounter(): JSX.Element {
  // Subscribe version counter; derive count from current state.
  useGameStore(selectBattlesVersion);
  const tick = useGameStore(selectTick);
  const battles = useGameStore.getState().battles;
  const seaCount = battles.filter((b) => b.isSeaInvasion).length;
  const aliveCount = Object.values(useGameStore.getState().sides).filter((s) => s.territoryCodes.length > 0).length;

  const stat = (label: string, value: string | number, color: string): JSX.Element => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      <span style={{ color: palette.textDim, fontSize: '0.6rem', letterSpacing: '0.15em', textTransform: 'uppercase' }}>{label}</span>
      <span style={{ color, fontSize: '0.85rem' }}>{value}</span>
    </div>
  );

  return (
    <div
      aria-label="Game stats"
      style={{
        position: 'absolute',
        left: 8,
        bottom: 8,
        background: 'rgba(0, 12, 28, 0.85)',
        backdropFilter: 'blur(8px)',
        border: `1px solid ${palette.cyanDim}`,
        padding: '6px 10px',
        fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
        display: 'flex',
        gap: 16,
        zIndex: 9,
      }}
    >
      {stat('Battles', battles.length, palette.cyan)}
      {stat('Sea', seaCount, palette.magenta)}
      {stat('Sides', aliveCount, palette.emerald)}
      {stat('Tick', tick, palette.amber)}
    </div>
  );
}
