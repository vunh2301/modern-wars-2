import { useState, useEffect } from 'react';
import { PixiRoot } from './render/PixiRoot';
import { FpsOverlay } from './ui/FpsOverlay';
import { SpeedControl } from './ui/SpeedControl';
import { Leaderboard } from './ui/Leaderboard';
import { BattleCounter } from './ui/BattleCounter';
import { WinnerOverlay } from './ui/WinnerOverlay';
import { Settings } from './ui/Settings';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { FatalError, detectWebGL2Issue } from './ui/FatalError';

/**
 * Root layout. Wraps PixiRoot in ErrorBoundary; runs WebGL2 capability check
 * at boot per SPEC Section 13.4. If unsupported, render FatalError instead.
 */
export function App(): JSX.Element {
  const [fatalMsg, setFatalMsg] = useState<string | null>(null);

  useEffect(() => {
    const issue = detectWebGL2Issue();
    if (issue) setFatalMsg(issue);
  }, []);

  if (fatalMsg) {
    return <FatalError message={fatalMsg} />;
  }

  return (
    <ErrorBoundary>
      <div className="app-root" style={{ width: '100%', height: '100%', position: 'relative' }}>
        <PixiRoot />
        <SpeedControl />
        <Settings />
        <Leaderboard />
        <BattleCounter />
        <FpsOverlay />
        <WinnerOverlay />
      </div>
    </ErrorBoundary>
  );
}
