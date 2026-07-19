# WebGPU pipeline perf rework — diagnosis, plan & progress

Living checklist for the shadow-path/post-chain performance regression on the
`godray-rework` branch. Additive: append to the Work log, check items off, never
delete history. Convention: completed items keep their original wording and get
a "→ DONE <date>: …" line appended; wrong statements get ~~strikethrough~~ plus
a "CORRECTION <date>: …" note — never silently rewritten. (Companions:
`GRAFT_TODO.md` for the vegetation graft, `vehicle_splitting_port.md`.)

## TL;DR diagnosis

This is not "a 4090 can't handle the vegetation" and not a Three r182 problem.
The stationary cost is dominated by ~~an always-on epipolar god-ray pipeline
running at an **unadvertised auto-scaled resolution** plus~~ a **48-step
full-drawing-buffer cloud god-ray march** at uncapped DPR. The movement cliff is
CSM drift refreshes + BSM compute dispatches + wholesale LAAS recenters
stacking in the same frames. Industry practice (and Takram's own reference
implementation) never runs these at full resolution per frame — everything is
cached, amortized, or reduced-res + temporally reconstructed.

CORRECTION 2026-07-18 (measured, see Work log): the epipolar-resolution half
of the diagnosis did NOT survive measurement — at 2560×1440 a 16× larger
epipolar grid (2048×1024 vs 512×256, 3 cascades vs 2) changed fps by 0. The
auto-override is real and Tier 0's fix is still right (own the budget), but
its current *cost* is negligible. The measured stationary buckets at 1440p:
cloud march ≈ 10.7 ms, LAAS veg ≈ 9.8 ms (casters ≈ 5.8 ms of it),
GTAO+contact ≈ 6.7 ms, of a 36 ms frame.

The regression boundary commit (985b8b0 → def574a) mixed CSM, terrain lighting,
the epipolar system, TAA/MRT/lens flare, AND enabled LAAS by default — so there
was never a clean shadows-off/shadows-on measurement. Do not tune from combined
FPS numbers.

## Verified findings (all confirmed against code, 2026-07-17)

Each item was checked in-source; file:line references are to this repo.

- [x] **autoSampleResolution silently overrides godRaySlices.** App configures
      512 slices / 256 samples (`webserver/main.webgpu.terrain.js:134`,
      `:3708-3709`), but `ShadowLengthNode.ts:87` defaults
      `autoSampleResolution = true` and `:186-191` overwrites
      `epipolarSliceCount`/`maxSliceSampleCount` every frame from
      `floorPowerOfTwo(max(w,h)/pixelRatio)`. A 1920-CSS-wide window becomes
      1024×512 — 4× the configured grid. The GUI slider is a placebo.
      Nuance: the auto-size divides by pixelRatio, so DPR does NOT inflate the
      epipolar grid — but the unwarp + everything downstream runs at full
      drawing-buffer res, so DPR compounds the rest.
- [x] **Uncapped devicePixelRatio.**
      `renderer.setPixelRatio(window.devicePixelRatio)` at
      `webserver/main.webgpu.terrain.js:446` (passed again at `:461`).
      DPR 2 ⇒ 3840×2160 = 8.29 M output pixels paying full post-chain cost.
- [x] **48-step full-res cloud god-ray march.**
      `CLOUD_GODRAY_ITERATIONS = 48` at `webserver/webgpu-cloud-godrays.js:46`
      ("up to", march exits at ~25.6 km). Up to ~398 M iterations/frame at
      DPR-2 1080p, each with cascade selection + transforms + sampling + exp.
- [x] **firstCascade = 0 for god rays.** Defaults 0 at `ShadowLengthNode.ts:100`;
      the app never sets it, so terrain god rays walk all three cascades
      including the 0.6 m/texel near one. Takram's skip hook is unused.
- [x] **CSM 3×2048², splits 500 m/8 km/50 km, terrain casts.**
      `webserver/main.webgpu.terrain.js:3427-3435`. Own comment at `:3423`
      documents sizes must be uniform (ShadowLengthNode derives texel size from
      cascade 0 only) — uniform 1024 is a valid 4×-raster-area reduction;
      mixed sizes are not safe.
- [x] **CSM caching does NOT cache the epipolar work.** Every ShadowLengthNode
      subpass (slice endpoints, coordinates, directions, min/max hierarchy,
      epipolar integration, full-res unwarp) is `NodeUpdateType.FRAME`.
- [x] **BSM refresh triggers.** `CloudBeerShadowMapNode.ts:183-195`: refresh on
      10 m camera move (`distanceToSquared > 100`), sun delta 1e-8, or frame
      interval. 512×512×3 map, up to 50 density samples/element ⇒ ~39 M density
      evals per dispatch. During fast movement this can fire every frame.
- [x] **LAAS recenter is a wholesale rebuild.** `RECENTER_STEP = 96` and
      `_recenter` at `webserver/laas-terrain-patch.js:25,427` — full patch
      regeneration every 96 m of travel.
- [x] **LAAS steady-state compute.** Forests: six cull/indirect kernels per
      frame. GroundRing scans `GRASS_GRID=1536²` + mid + `FAR_GRID=768²`
      (~3.2 M candidate threads/frame) — `webserver/laas/vegetation/GroundRing.ts:92,124`.
- [x] **Understory/grass do NOT cast into CSM** (ringCasts=false; GroundRing
      never casts); rocks/extras DO get per-cascade caster siblings. "All the
      plants cast shadows" is not the explanation.
- [x] **`?ablate=` flags are broken in this app.** Boot strips the query string
      via `history.replaceState` (`webserver/main.webgpu.terrain.js:167-168`)
      after capturing `BOOT_QUERY`; `webserver/laas/render/ShadowSetup.ts:115`
      and `laas/render/PostStack.ts:75` read `window.location.search` afterward
      and see nothing. **All past ablation measurements via those flags are
      invalid.** (Host code knows — comment at `main.webgpu.terrain.js:5288` —
      LAAS modules were never updated. Real flag values: shadows, pcss,
      cloudshadow, clouds, ao, taa, bloom, bounce. ~~`casters` is not one.~~
      CORRECTION 2026-07-17: `casters` IS one — it lives in
      `laas/vegetation/Forests.ts` (not ShadowSetup/PostStack) and drops ALL
      veg caster draws; the external AI had the flag name right.)
- [x] **Parallel cloud-dispatch changes are NOT the ongoing cause.** The
      procedural texture nodes exit permanently once `computeDispatched` is
      true; they affect startup/rebuild only.

### Debug console snapshot (verified — all handles exist)

`window.__atlantisWebGPU` is set at `main.webgpu.terrain.js:3660`
(renderer, THREE, shadowLengthNode, csmShadowNode, beerShadowMap, …);
`csm._refreshStats` attached at `:5350`; `dispatchCount` at
`CloudBeerShadowMapNode.ts:125,198`.

```js
const h = window.__atlantisWebGPU;
({
  css: [innerWidth, innerHeight],
  dpr: devicePixelRatio,
  buffer: h.renderer.getDrawingBufferSize(new h.THREE.Vector2()).toArray(),
  epipolarSlices: h.shadowLengthNode.epipolarSliceCount.value,
  epipolarSamples: h.shadowLengthNode.maxSliceSampleCount.value,
  csmRefreshes: h.csmShadowNode._refreshStats,
  beerDispatches: h.beerShadowMap.dispatchCount
});
```

## Research validation (2026-07-17)

Checked the plan against industry practice; everything below confirms the
approach and none of it contradicts it.

- **Takram's own reference numbers**: a GeForce **4090 sustains only 60 fps at
  Ultra** on their Tokyo scene — *with* `temporalUpscaling` on, which marches
  **1/16 of texels per frame** and reconstructs the rest temporally. Low/Medium
  presets disable light shafts entirely as the first cost lever.
  → We're doing something the library authors deliberately never do
  (full-res per-frame march).
  https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/clouds/README.md
- **Reduced-res volumetrics + temporal reconstruction is universal**: god rays
  are low-frequency; half/quarter res + depth-aware bilateral upsample is
  standard; UE5 volumetric fog = low-res froxels + temporal reprojection.
  https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process
  https://garagefarm.net/blog/volumetric-lighting-in-rendering-techniques-and-performance
- **DPR cap ≈ 2 is the universal three.js rule** (`Math.min(dpr, 2)`; R3F
  defaults `[1, 2]`). For a scene this heavy, an explicit resolution-scale
  setting is better still.
  https://simplified.media/guides/webgl-threejs
  https://github.com/pmndrs/react-three-fiber/discussions/1133
- **Epipolar sampling exists to avoid per-pixel raymarch — IF you own the slice
  budget.** Original technique + 1D min-max mipmaps use small explicit slice
  counts; auto-quadrupling the grid defeats the point.
  https://www.researchgate.net/publication/220791902
  https://groups.csail.mit.edu/graphics/mmvs/mmvs.pdf
- **CSM caching + per-cascade update cadence is standard**: near cascade every
  frame, far cascades every few frames or held static; Unity URP exposes this
  as a first-class optimization.
  https://hypesio.fr/en/dynamic-shadows-real-time-techs/
  https://www.tsarengine.com/Blogs/Article?slug=how-we-optimized-cascaded-shadow-mapping
  https://docs.unity3d.com/6000.3/Documentation/Manual/shadows-optimization.html
- **Incremental vegetation/terrain recentering has direct precedent**: Horizon
  does GPU placement per approached tile; Ghost of Tsushima's entire grass
  system fits ~2 ms with depth-pyramid occlusion culling. The canonical fix for
  the 96 m wholesale rebuild is the **geometry-clipmap toroidal update** —
  wraparound addressing, refill only the newly exposed L-shaped strip.
  https://gdcvault.com/play/1027033/Advanced-Graphics-Summit-Procedural-Grass
  https://forum.unity.com/threads/horizon-gpu-procedural-placement.462019/
  https://hhoppe.com/geomclipmap.pdf
  https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-2-terrain-rendering-using-gpu-based-geometry

## Plan

Principle: **preserve every feature, decouple the costs, own every budget.**
No architectural change before per-bucket measurements exist.

### Tier 0 — cheap correctness fixes (one-liners, do first)
- [x] `shadowLengthNode.autoSampleResolution = false` so `godRaySlices` is
      actually honored (set it where the node is created/configured).
      → DONE 2026-07-17: set at node creation with explicit slice/sample init
      (`main.webgpu.terrain.js`, shadowLength setup). Verified live headless:
      512/256 held after 5 s of frames (pre-fix a 1280-wide window forced
      1024×512).
- [x] Cap pixel ratio: `Math.min(window.devicePixelRatio, 2)` at
      `main.webgpu.terrain.js:446,461` — or better, an explicit
      resolution-scale setting with a sane default.
      → DONE 2026-07-17: capped at 2 at renderer creation; bootLog now reports
      both `pixelRatio` (effective) and `devicePixelRatio` (raw). Explicit
      resolution-scale setting still open (folded into Tier 3 quality budget).
      Headless DPR=1 can't exercise the cap — confirm on a retina headed run.
- [x] `shadowLengthNode.firstCascade = 1` — god rays skip the detailed near
      cascade (Takram hook exists, unused).
      → DONE 2026-07-17: `firstCascade.value = 1`; verified the uniform is
      plumbed through slice-UV/min-max/epipolar subnodes (loop runs
      firstCascade→cascadeCount with relative indexing). Sunrise boot
      screenshot looks correct; proper visual A/B in Tier 1.
- [x] Fix LAAS ablate flags: `ShadowSetup.ts` + `PostStack.ts` must read
      `BOOT_QUERY` (or a handle the host passes), not `window.location.search`.
      Future ablation measurements are worthless until this lands.
      → DONE 2026-07-17, wider than planned: 21 dead reads across 13 laas
      files (Particles partdbg, Clouds, BrowserGate nogate, Params,
      ShadowSetup ablate, WaterMaterial waterdbg, PostStack ablate/cloudview/
      skyveldbg/lockexp, Season freeze, VegInstance facedbg/shadcut,
      TerrainTiles ablate/caustlit/dispdbg/caustmip, WorldConst season,
      GroundRing prepass, Forests prepass/ablate/clsdbg). New
      `laas/core/BootQuery.ts` falls back to `window.__BOOT_QUERY` (exposed by
      the host at capture time, before the strip); standalone laas still reads
      the live URL. Verified end-to-end headless with `?ablate=casters`:
      location.search='' (stripped), host handle sees 'casters', laas-module
      import of bootQuery() sees 'casters'.

### Prior measurement context (2026-07-17, pre-rework)
Headless 1280×720, 700 m over Nuuk, contended GPU, stationary: steady
~22–30 fps; hiding the LAAS veg clipmap → ~31 fps (**veg ≈ 13 ms**); after the
invalidation-driven refresh landed (98ad86d), shadow refreshes ≈ 0/frame
stationary and shadows measured **in the noise**. Caveats: 720p minimizes
exactly the costs that scale with output pixels (epipolar unwarp, cloud march,
grounding, TAA), and the ablate-flag bug means any `?ablate=` numbers from that
era are untrusted. The full-res desktop picture may rank buckets differently —
that's what Tier 1 must establish. Also: toggling `atmosphereLight.castShadow`
at runtime forces a full material recompile — never do it mid-measurement.

### Tier 1 — measurement protocol (before any architecture work)
- [ ] GPU timestamp buckets, captured separately **stationary** and in
      **controlled motion** (fixed flythrough path). Buckets: scene draw, each
      CSM cascade, epipolar preprocessing + unwarp, cloud god-ray fold,
      GTAO/contact, BSM compute, LAAS culling, LAAS recenter.
      → PARTIAL 2026-07-18: stationary compile-out sweep done via the fixed
      boot flags (headless 2560×1440, 05:30Z, ~25 s measured per config,
      scripts in session scratchpad `bucket-sweep2.mjs`/`ab-tier0.mjs`):
      | config            | fps  | bucket cost |
      | base (all on)     | 27.6 | —           |
      | ?cloudGodRays=0   | 39.2 | march ≈ 10.7 ms |
      | ?procgenPatch=0   | 37.9 | all veg ≈ 9.8 ms |
      | ?gtao=0&contact=0 | 33.9 | grounding ≈ 6.7 ms |
      | ?ablate=casters   | 32.9 | veg casters ≈ 5.8 ms |
      Epipolar A/B (live toggle, same session): 512×256+firstCascade1 vs
      2048×1024+firstCascade0 = 23.5/24.0/24.6 fps — **no measurable epipolar
      cost**. Grounding was "in the noise" at 720p, ≈6.7 ms at 1440p —
      pixel-scaling confirmed. GPU timestamp queries + controlled-motion runs
      still open.
- [ ] Never report a combined FPS number; a 720p result does not validate a
      pipeline whose costs scale with output pixels.
- [ ] Re-run the caster/stage ablations with the fixed flags; discard all
      pre-fix ablation conclusions.
      → DONE 2026-07-18 for the stationary set (table above).

### Tier 2 — budget the movement cliff
- [ ] CSM refresh budget: at most one cascade refresh per frame during motion
      (round-robin over invalidated cascades; near cascade gets priority).
      → IMPLEMENTED 2026-07-18 (verification pending): candidate/grant split
      in `updateTerrainShadowBudget` — collect all triggered cascades, sort by
      reason urgency (recenter/projection > drift > sun > vehicle > stream >
      fallback) then near-first, grant ≤ `?csmBudget=N` (default 1, 0 =
      uncapped A/B) per frame; 'init' exempt. Consumed triggers
      (recenter/projection/vehicle) latch into sticky per-cascade flags so
      deferred cascades re-compete next frame; threshold triggers re-detect
      because state is only stamped on grant. `_refreshStats.deferred` counts
      deferrals. Safe because frozen cascades lag coverage, never swim (r182,
      see Verified facts in [[csm-shadow-rework-plan]] memory).
- [ ] Evaluate uniform 1024² cascades (valid per our own `:3423` comment; 4×
      raster area + smaller min/max hierarchy) — decide from Tier 1 numbers,
      not by feel.
- [ ] BSM: decouple from per-frame movement (larger move threshold, amortized
      partial updates, or slices spread over N frames).
- [ ] LAAS recenter: toroidal/clipmap-style incremental refill of the exposed
      strip instead of wholesale 768 m patch rebuild every 96 m.

### Tier 3 — architectural decoupling (largest single item)
- [ ] Cloud god-ray fold at reduced resolution (½ or ¼) with temporal
      reconstruction + depth-aware upsample — how the reference WebGL
      implementation survives on the same GPU.
      → STAGE 1 IMPLEMENTED 2026-07-18 (verification pending): the 48-step
      march now renders into a half-res HalfFloat target (`ScaledRTTNode`
      subclass of three's RTTNode, tracks drawing-buffer size × 0.5) and is
      bilinearly upsampled in the full-res merge; segment stays in meters so
      uStrength/worldToUnit tune live without re-rendering the target.
      `?cloudGodRaysFull=1` = old per-pixel path for A/B. Temporal
      reconstruction + depth-aware upsample remain open (watch for silhouette
      halos from plain bilinear).
      → VERIFIED 2026-07-18 (headless 2560×1440, 05:30Z sunrise, same-session
      A/B): half-res 32.9 fps vs full-res 22.2 fps (**+48%, ≈14.6 ms/frame
      recovered**). Screenshots pixel-comparable: mountain silhouettes clean,
      no visible halos or blockiness at this scene. Caveat: sunrise scene has
      sparse cloud shadowing — re-check under heavy broken overcast before
      calling the upsample final. (Control config ?cloudGodRays=0 read 1.0 fps
      this run — still compiling during measurement, discard; the earlier
      sweep measured it at 39.2.)
- [ ] Keep detailed near-surface CSM separate from coarse cached distant
      terrain occlusion.
- [ ] Do NOT start with the r185 upgrade; upgrading cannot correct hundreds of
      millions of intentional per-pixel operations.

## New fronts opened 2026-07-18 PM (user live-test feedback)

- [x] **God rays degraded at ground level** — caused by Tier 0's
      firstCascade=1 (zero measured fps benefit, real visual cost: terrain
      within 500 m stopped carving shafts). REVERTED to 0; `?godRayFirstCascade=1`
      kept for A/B.
- [x] **Giant stale shadow band beyond the LAAS patch during flight** — my
      CSM budget starved far cascades (near cascade re-drifts every frame and
      won every grant). Fixed: stalest-first ordering among equal urgency
      (natural round-robin). Verified: grants [3,3,2] over a 20 s flight leg,
      no band in screenshots.
- [x] **Freeze during fast movement (partial)** — BSM re-dispatched its full
      density march every frame above ~36 km/h (10 m move trigger).
      Added `minDispatchInterval = 10` frames floor in CloudBeerShadowMapNode.
      The other half is the wholesale 96 m LAAS recenter (Tier 2, user's WIP).
- [x] **Flask served everything single-threaded** — `app.run` without
      `threaded=True` serialized every tile/texture/fields request behind
      30 s external satellite fetches; one slow dataforsyningen call froze
      streaming, textures AND fields together during flythroughs. Fixed
      (+ sqlite already used check_same_thread=False throughout).
- [x] **Texture enhancement silently dead** — SUPIR/ComfyUI tailscale IP was
      hardcoded in texture.py and went stale when the GPU box re-enrolled
      (old 100.106.176.121 no longer in the tailnet) → 0/6429 enhanced all
      day. Fixed: COMFY_URL now env-only (flaskserver/.env, gitignored);
      unset = enhancement cleanly disabled. NOTE: nothing answers on :8188 on
      any current tailnet node — ComfyUI must be started on the 4090 box.
- [x] **"No plants" forensics — veg pipeline itself WORKS.** Cold boot over a
      high-veg tile (64.0309, -51.81835) places 21k grass, visually
      confirmed. The bare areas the user saw (Nuuk spawn/coast) have
      classifier veg ≈ 0.00-0.21 max (fresh recompute matches cache — not
      poisoned; those fjord-shore tiles genuinely classify barren). Open
      questions that remain:
      - [ ] plants/rocks/understory scatter is 0 EVERYWHERE and always has
            been (192/192 log entries since 07-17) — unfinished wiring in the
            clipmap/worldSize WIP (Scatter.ts/Forests). Also 4× console
            warnings `Vertex attribute "vdata" not found on geometry`.
      - [ ] classifier veg looks under-reported for Greenland moss/tundra
            (terrain paint shows moss where grass threshold says barren) —
            threshold/classifier tuning vs GroundRing gate mismatch.
      - [ ] fields are only served at depth 12 (64² per ~660 m tile ≈ 10 m/px)
            — coarse for a 768 m patch; consider deeper fields or higher res.
- [x] **No visible clouds on WebGPU** — not a regression: CloudsEffect (the
      visual clouds) only exists in the WebGL path; the WebGPU port stage 1
      brought only density field + BSM (shadows/god rays). Stage 2 (visible
      clouds) is an open roadmap item, now explicitly tracked here.

## Work log (append-only, newest last)

- **2026-07-17** — Verified external AI's regression analysis against source:
  all load-bearing claims confirmed (see Verified findings). Researched
  industry practice; plan validated, added reduced-res+temporal cloud fold and
  CSM per-frame refresh budget as explicit items. Created this file. No code
  changed yet.
- **2026-07-17 (later)** — **Tier 0 landed and verified headless** (1280×720,
  05:30Z sunrise over Nuuk): epipolar grid holds 512×256 with
  autoSampleResolution off; firstCascade=1; DPR capped at 2; all 21 LAAS
  boot-flag reads routed through new `laas/core/BootQuery.ts` →
  `window.__BOOT_QUERY`, proven end-to-end with `?ablate=casters`. Boot
  screenshot bright and artifact-free. Correction to findings: `ablate=casters`
  DOES exist (Forests.ts, drops all veg caster draws) — earlier note said
  otherwise. Snapshot from the run: csmRefreshes {init:3, drift:102, vehicle:4,
  stream:4, recenter:3} over ~5 s of forced frames + boot, beerDispatches 6 —
  drift is already the dominant refresh reason even in a near-stationary
  mouse-wiggle run; Tier 2's one-cascade-per-frame budget is well motivated.
  Ablation baselines can now be trusted; ready for Tier 1 measurements.
- **2026-07-18** — Measurement day + first big win. (1) Epipolar A/B at
  2560×1440: 16× grid difference = 0 fps difference → epipolar half of the
  diagnosis disproven (correction noted in TL;DR). (2) Stationary compile-out
  sweep via the fixed flags (table in Tier 1): cloud march ≈10.7 ms > veg
  ≈9.8 ms > grounding ≈6.7 ms of a 36 ms frame; grounding invisible at 720p
  but ≈7 ms at 1440p — pixel-scaling confirmed. (3) Implemented CSM refresh
  budget (≤1 cascade/frame, urgency-ranked, sticky deferrals, ?csmBudget=N)
  — motion verification still open. (4) Implemented + verified half-res cloud
  march: **22.2 → 32.9 fps (+48%) at 1440p**, screenshots visually identical,
  no silhouette halos at sunrise; re-check under heavy overcast. Base full
  pipeline now ≈33 fps at 1440p headless vs 27.6 before today. Next: motion
  runs for the CSM budget + BSM behavior, then veg (≈10 ms) and grounding
  (≈7 ms) buckets, then temporal reconstruction to push the march to ¼ res.
- **2026-07-18 (LAAS recovery continues)** — The working standalone LAAS
  flight runtime on port 5174 is now the executable reference for the Atlantis
  graft. Detailed additive findings, source changes, tests and pending flight
  verification are tracked in `ATLANTIS_LAAS_RECOVERY.md`; this performance log
  remains the source of pass-level stationary and motion measurements.
- **2026-07-18 (terrain transport rejection)** — Measured the live 20 km
  `/api/tiles` snapshot at 43,164,335 JSON bytes / 1,884 embedded heightmaps
  (1,428 at depth 12), taking about two minutes locally. This is now a primary
  movement blocker independent of render-pass tuning: unchanged heightmaps are
  retransmitted and reparsed on every refetch. The additive recovery log owns
  the replacement world-partition requirements; pass-level GPU work remains
  relevant only after transport/residency is bounded.
- **2026-07-19 (bounded streaming + visual correctness)** — WebGPU now requests
  a 384-leaf balanced manifest and versioned binary pages; the same 20 km query
  measured ~191-193 KB in 117-133 ms instead of 43.16 MB, with unchanged pages
  retained client-side. Production motion recovered from ~0.45 fps/repeating
  3.3 s frames to 50.07 fps average (16.7 ms median, 200.1 ms worst); the worst
  hitch is still above acceptance. Screenshot forensics then found four visual
  bugs independent of the frame-rate win: stale unversioned classifier blobs,
  dark-flat land classified as 84.7% water, screen-space rock LOD dithering,
  and legacy near-opaque ShadowMaterial terrain receivers running beside the
  scene CSM. All are corrected and documented with fresh-page counts/raycast
  evidence in `ATLANTIS_LAAS_RECOVERY.md`. Exact coastal proof: 6,377 plants,
  10,172 grass drawn, 12,143 rocks generated; no duplicate ShadowMaterial hit.
- **2026-07-19 (WebGPU varying-limit correction)** — Instrumented runtime
  validation exposed eight local-detail render pipelines at 17 vertex-output
  locations against WebGPU's limit of 16. The stable rock LOD threshold and
  two tint hashes now share one `vec3` varying instead of consuming two
  locations, and unused full-physical material variants were removed from the
  local-detail path. Final fresh-scene verification produced no shader/pipeline
  validation errors. An earlier 51.83 fps sample was rejected because it ran
  with the invalid pipelines. Validation-clean same-site 834.8 m movement:
  37.79 fps average, 17.1 ms p50, 34.2 ms p95, 200.1 ms p99, 250 ms worst.
  Startup at a separate 700 m test coordinate still timed out at 120 s and
  remains explicitly open.
- **2026-07-19 (rock grounding/camera stability)** — Screenshot forensics and
  a same-coordinate GPU readback separated rock placement from streaming.
  Atlantis sampled a bilinear DEM saddle while the visible terrain renders two
  planar triangles; prop grounding now uses the exact terrain index split and
  has direct unit coverage. Rigid LOD rings use stable object-surface dithering
  instead of either screen noise or a whole-object slot threshold, and the
  existing 12-tap contact ray now spans the scaled boulder range. Fresh probe:
  3,340 large extras + 16,694 stones generated; two settled camera headings
  both produced 3,128 visible rock/extra draws and no WebGPU validation error.
  This does not close flight streaming continuity: the current 45 m/s detail
  gate and in-place 192 m reseed still hide the whole procedural root. The
  proper follow-up is resident old/new patch handoff or a macro-rock tier, not
  another threshold tweak.
- **2026-07-19 (cruise tier + half-resolution grounding)** — User clarified
  that cruise/fast flight should intentionally retain the 12 m satellite/DEM
  terrain while the monolithic micro-detail patch is inactive, then restore
  procgen only after slowing/descending. The 30/45 m/s and 500 m AGL gates are
  therefore retained with a new prewarm/current-coverage handoff; the frozen
  predictive-streaming proposal records this correction additively. At the
  Osprey maximum of 141 m/s, forcing procgen on measured 33.3 ms p50, 50.9 ms
  p95 and seven recenters across 835.5 m. The intended cruise tier performed
  zero procgen recenters. GTAO/contact's previously measured ~6.7 ms desktop
  bucket is now evaluated as a half-resolution scalar mask (the LAAS source
  design) and reconstructed over full-resolution color. Same-size 1961x1062
  cruise improved from 32.5/34.2/84.3 ms p50/p95/worst to
  **16.7/17.6/66.7 ms**, with no WebGPU validation error. Slow-down restored
  the correct procgen cell in 990.6 ms without showing the stale root; its warm
  rewrite was still 163.6 ms and remains over the 50 ms hitch gate.
