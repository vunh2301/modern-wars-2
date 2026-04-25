# Modern Wars — Hex Map Renderer

> **Reset to v1.0 spec.** Phase 1 only: render hex grid world map. **Không có gameplay.**

Spec: [docs/SPEC.md](./docs/SPEC.md)

## Status

🟡 **Phase 0 / 5** — Reset commit. Code wipe completed; new architecture per hex-grid spec started fresh.

## Stack

- Vite ≥ 7 + TypeScript ≥ 5.4
- Pixi.js 8.6.6 (vanilla, exact pin)
- pixi-viewport 6 (pinch zoom + pan)
- honeycomb-grid 4 (flat-top axial hex math)
- rbush 4 (build-time spatial index)
- Brotli compressed binary tier files
- Service Worker + IndexedDB caching

## Target

- 60 FPS p95 trên iPhone 13 Pro Max Safari
- Boot < 1500ms cold, < 300ms cached
- 100% quốc gia (kể cả Vatican) hiện diện
- Pinch zoom 1× → 32× smooth

## Out of scope (Phase 1)

❌ NO combat / battles / AI / corps / cities / HUD / audio / gameplay logic.

Spec Section 15 lists negative list explicitly. Phase 2 gameplay TBD sau Phase 1 done.

## Deploy

Vercel auto-deploy `main`. URL: https://modern-wars-2.vercel.app/ (TBC nếu giữ domain hay mới).

## License

TBD
