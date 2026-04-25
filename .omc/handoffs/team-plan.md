## Handoff: team-plan → team-exec

**Date:** 2026-04-25
**Team:** mw2-build
**Lead:** team-lead@mw2-build (Claude Opus 4.7)

### Decided

- **Spec source:** `docs/SPEC.md` (1855 lines, 20 sections, scored Opus 9.62 / Codex 9.61 ACCEPT) — single source of truth.
- **Repo:** https://github.com/vunh2301/modern-wars-2 (main branch protected, deploys to https://modern-wars-2.vercel.app/).
- **Phase strategy:** Phase 0 sequential (gate), then 3 parallel worker tracks (A: data+render, B: sim+combat, C: UI+audio+resilience).
- **10 task graph:** #1 Phase 0 → branches to #2-#10 with dependencies (see TaskList).
- **Worker assignment:** worker-a (#1, #2, #3, #8) data+render, worker-b (#4, #5, #9) sim+combat+bench, worker-c (#6, #7, #10) UI+audio+resilience.
- **Branch convention:** `worker-{a|b|c}/phase-N-name`, PRs into main, code-reviewer pass before merge.
- **CI gates (Section 12):** lint (no Math.random in sim/data), typecheck strict, build:world < 30s, bundle ≤ 350KB initial / 500KB total gz, bench:headless 3-run hash identical.

### Rejected

- **Single-worker sequential execution**: would take 18-26h serial; parallel cuts to ~10h critical path.
- **Spawn all 3 workers immediately**: workers B/C would burn tokens idle waiting for Phase 0 unblock. Better: spawn A first, then B+C after Phase 0 done message.
- **Tier-based execution by phase number**: doesn't respect dependency graph (Phase 6a needs both 1b and 3).

### Risks

- **Phase 0 dependency injection mistakes**: ESLint config or Vite config wrong → blocks all subsequent work. Mitigation: thorough Phase 0 verifier pass before unblocking B/C.
- **Determinism contract drift**: workers B + C might use Math.random independently → CI fail. Mitigation: ESLint enforces, fail fast in lint step.
- **Type drift between worker tracks**: worker-a defines BorderTierFile, worker-b expects different shape. Mitigation: types committed in Phase 0 stub (src/data/types.ts placeholder), workers extend not redefine.
- **Merge conflicts in src/**: workers touching shared files. Mitigation: file-scoped task ownership (data → worker-a, sim → worker-b, ui → worker-c).
- **Spec interpretation drift**: Section 4.6 MultiPolygon contract complex. Mitigation: workers MUST cite Section/line in commit messages when implementing contracts.

### Files

- Spec: `docs/SPEC.md`
- Tasks: `~/.claude/tasks/mw2-build/{1..10}.json`
- Team config: `~/.claude/teams/mw2-build/config.json`
- This handoff: `.omc/handoffs/team-plan.md`

### Remaining (for team-exec stage)

1. Lead spawns worker-a (executor model=opus) for Phase 0.
2. Worker-a completes Phase 0, sends message to lead with PR link.
3. Lead runs verifier pass on Phase 0 (verifier agent).
4. If verifier passes → lead spawns worker-b + worker-c in parallel (sonnet model).
5. Workers pick up unblocked tasks autonomously.
6. Lead monitors via SendMessage + TaskList polling.
7. After all phases complete → team-verify pass → team-fix loop nếu cần.
8. Final: deploy verification at https://modern-wars-2.vercel.app/.
