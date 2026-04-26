/**
 * Phase 8 stub handlers for Phase 9/10 job types.
 *
 * Each stub returns a NotImplementedError result. Phase 9 replaces these with
 * real handlers in decoder.worker.ts — the worker entry boilerplate (handshake,
 * job routing, cancel) stays unchanged.
 *
 * Interfaces are LOCKED — Phase 9 implements the same shapes:
 *   - PathfindJob → PathfindResult (Int16Array packed path buffer)
 *   - AiTickJob   → AiTickResult  (ArrayBuffer SoA commands)
 *   - CombatJob   → CombatResult
 */
import type { AiTickJob, CombatJob, PathfindJob } from './types';
import type { PathfindResult, AiTickResult, CombatResult } from './types';

const NOT_IMPL_MSG = 'Phase 9 will implement this handler';
const NOT_IMPL_NAME = 'NotImplementedError';

export function handlePathfindStub(job: PathfindJob): PathfindResult {
  return {
    type: 'pathfind',
    id: job.id,
    ok: false,
    error: NOT_IMPL_MSG,
    errorName: NOT_IMPL_NAME,
  };
}

export function handleAiTickStub(job: AiTickJob): AiTickResult {
  return {
    type: 'ai-tick',
    id: job.id,
    ok: false,
    error: NOT_IMPL_MSG,
    errorName: NOT_IMPL_NAME,
  };
}

export function handleCombatStub(job: CombatJob): CombatResult {
  return {
    type: 'combat',
    id: job.id,
    ok: false,
    error: NOT_IMPL_MSG,
    errorName: NOT_IMPL_NAME,
  };
}
