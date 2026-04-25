# Modern Wars 2.0

Risk-style real-time strategy map game — Spectator/AI mode.

177 quốc gia (Natural Earth 50m), real-time tick-based combat, sea-lane adjacency, deterministic sim, target 60fps trên iPhone 12 Safari.

## Status

**Spec phase** — implementation chưa bắt đầu. See [docs/SPEC.md](./docs/SPEC.md) (~1800 lines, 20 sections, scored 9.62 Opus / 9.61 Codex).

## Stack

- Vite 7 + TypeScript strict
- React 18 (HUD only)
- Pixi.js 8.6.6 (vanilla, no react-pixi)
- Zustand + immer (state)
- Tone.js 15 (audio, lazy-loaded)
- seedrandom (deterministic PRNG)

## Acceptance gates

- 60fps sustained @ zoom 1× idle, p95 frame ≤ 18.2ms với 50+ battles
- Boot ≤ 1500ms iPhone 12 Safari
- Bundle ≤ 350KB gz initial / ≤ 500KB gz total app
- Deterministic sim: 3-run hash identical (CI gate)

## Visual style

Terminal/sci-fi vibe — dark cyan/magenta accents, JetBrains Mono, scanlines, glow effects (Section 20).

## Development phases (18-26h total)

| Phase | Scope | Time |
|---|---|---|
| 0 | Project bootstrap (Vite + TS + Pixi + ESLint + palette) | 1h |
| 1a | Build-time world data pipeline | 2h |
| 1b | Boot loader + render | 2h |
| 2 | State + sim loop | 2h |
| 3 | Combat core | 3h |
| 4 | UI + leaderboard | 1.5h |
| 5 | Audio + game feel | 2h |
| 6a | LOD implementation | 2h |
| 6b | Benchmark + telemetry | 2h |
| 7 | Optimization (conditional) | 2-6h |
| 8 | Resilience hardening | 1.5h |
| 9 | Vercel deployment | 1h |

## Deploy

Vercel (recommended) — see [Section 19](./docs/SPEC.md#19-deployment--cicd).

## Local dev (after Phase 0)

```bash
npm install
npm run build:world  # pre-compute world data
npm run dev          # http://localhost:5173
npm run build        # production build
```

## License

TBD
