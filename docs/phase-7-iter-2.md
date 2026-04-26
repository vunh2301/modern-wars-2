# Phase 7 — Iter 2 hypothesis & fix

> Iteration: **2 of 3**
> Trigger: iter 1 (drop CPU cache) made memory worse (618 → 710 MB) — invalidated cache hypothesis. Per arch § 2.1 fallback: switch to C2 instanced rendering.
> Date: 2026-04-26

---

## What iter 1 taught us

Removing the CPU `ChunkCache` increased peak memory because re-fetch
churn under pan-storm produces more transient ArrayBuffers pre-GC than
the cache holds.

Therefore the dominant memory cost is **NOT the JS-side ChunkCache** —
it's the **per-chunk vertex buffer (~4.7 MB) duplicated across CPU
ArrayBuffer + Pixi GPU buffer mirror**.

C1 layout (per-vertex packed) has:
```
6 vertices/hex × 12 B = 72 B/hex
At 39K hex/chunk: 2.8 MB vertex + 1.9 MB index + 80 KB edges = 4.8 MB raw
```

Tint duplicated 6× per hex (per-vertex) is the smoking gun. C2 (instanced
rendering) shares the 6-vertex template across all hex instances and
stores per-hex data ONCE.

## ONE specific fix

**Switch from C1 (per-vertex packed) → C2 (instanced rendering)**.

New per-chunk binary (`MWCK v2`):

```
Header (16 B):           magic + version=2 + tier_km + col + row + hex_count
Template buffer (48 B):  6 vertices × (x:f32, y:f32) PRE-SCALED to hexSizeWorldPx
Instance buffer (12 B/hex): per-hex (cx:f32, cy:f32, RGBA:u8×4)
Static index buffer (48 B): 12 uint32 (fan triangulation, shared)
Edge prefix (4 B) + edges (16 B/edge) + footer (32 B)
```

Per-chunk size @ 10 km (39 K hexes, ~5 K edges):
```
16 + 48 + 39000×12 + 48 + 4 + 5000×16 + 32 = 548 KB raw
~165 KB compressed (gzip ~30 %)
```

vs C1: 4.8 MB raw / ~1.5 MB compressed → **~10× smaller per chunk**.

24-chunk active state in JS heap:
- Instance buffers: 24 × 480 KB = ~12 MB
- Pixi GPU mirror: ~12 MB
- Template (48 B × 24 = 1 KB negligible)
- ChunkBuffers cache views: ~12 MB
- Total: ~36 MB (vs C1's ~230 MB)

Pre-GC churn from pan storm: ~50 chunks × 480 KB = ~24 MB. Total peak
estimate: ~120 MB. **Under 250 MB target with margin.**

## Implementation plan

`scripts/bake-chunks.ts`:
1. Bump magic version to **2**.
2. Replace `encodeChunkBinary` with C2 layout.
3. Per chunk: emit pre-scaled hex template (6 verts × 8 B = 48 B once),
   instance attrs (hex × 12 B), shared index (12 × 4 B = 48 B once).
4. Re-bake `npm run bake:chunks` produces v2 binaries.

`src/data/chunks.ts`:
5. Update `parseChunkBinary` to v2 layout.
6. Add `templateBuffer: ArrayBuffer` and `instanceBuffer: ArrayBuffer`
   fields to `ChunkBuffers` (replaces `vertexBuffer`).

`src/render/meshHexLayer.ts`:
7. Build instanced `Geometry` with `instance: true` attrib flag:
   ```ts
   new Geometry({
     attributes: {
       aTemplate:      { buffer: templateBuf, format: 'float32x2' },
       aInstancePos:   { buffer: instBuf, format: 'float32x2', offset: 0, stride: 12, instance: true },
       aInstanceColor: { buffer: instBuf, format: 'unorm8x4', offset: 8, stride: 12, instance: true },
     },
     indexBuffer: indexBuf,
     topology: 'triangle-list',
     instanceCount: hexCount,
   });
   ```
8. Mesh + Shader unchanged interface; just Geometry layout differs.

`src/render/hexShader.ts`:
9. New vertex shader:
   ```glsl
   attribute vec2 aTemplate;
   attribute vec2 aInstancePos;
   attribute vec4 aInstanceColor;
   uniform mat3 uProjectionMatrix;
   uniform mat3 uWorldTransformMatrix;
   uniform mat3 uTransformMatrix;
   varying vec4 vColor;
   void main() {
     vec2 worldPos = aInstancePos + aTemplate;
     vec3 p = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(worldPos, 1.0);
     gl_Position = vec4(p.xy, 0.0, 1.0);
     vColor = aInstanceColor;
   }
   ```

`docs/phase-7-architecture.md`:
10. Add note: D-4 changed from C1 → C2 in iter 2.

## Predicted post-iter-2 outcome

| Gate                                 | Iter 0 (C1)      | Predicted iter 2 (C2)                     |
|--------------------------------------|------------------|-------------------------------------------|
| memory_peak_under_250mb              | 618 MB ✗         | ~120 MB ✓ (5× drop, well under target)    |
| chunk_build_p95_under_8ms            | 1.8 ms ✓         | ~1 ms ✓ (smaller GPU upload)              |
| tier_switch ≤ 80 ms                  | 0.9 ms ✓         | ~0.5 ms ✓ (smaller manifest fetch)        |
| FPS p95                              | 138 fps ✓        | ✓ (instanced is GPU-friendly)             |
| Bundle size                          | 43.65 MB         | ~5 MB (11× smaller chunks total)          |

If memory < 250 MB → PHASE 7 PASSES, write retro.
If memory > 300 MB → unknown culprit (Pixi internals); iter 3 candidate
= shrink LRU cap from 24 → 12 to halve active footprint.

## Risks

- **R1**: Pixi v8 `instance: true` attribute flag API may differ from
  assumption. Verify in implementation; if wrong, fallback to manual
  `gl.drawArraysInstanced` via custom RenderObject (iter 3 territory).
- **R2**: `instanceCount` parameter on Geometry may need to be set on
  Mesh instead. Verify.
- **R3**: iOS Safari WebGL2 instancing extension support — should be
  universal on iOS 13+, but verify in 7.5 device test.
- **R4**: Re-bake invalidates existing `public/data/chunks/*.bin` files
  baked under MWCK v1. `bake:chunks` overwrites; old files removed.

## Rollback plan

`git revert <iter-2-commit>` → restores C1 + v1 binaries (need re-bake).

---

> END OF ITER 2 HYPOTHESIS
