# Procedural asset scatter — architecture (AAA / sim pattern, multiplayer-native)

The goal: from real Greenland data (satellite texture + ArcticDEM + land-cover
priors), place plants and rocks in the right spots, densely, identically on every
client. This follows the standard AAA/sim approach (Houdini scatter, Unreal PCG,
MS Flight Simulator): **continuous weight fields → per-species density rules →
deterministic hash scatter → LOD instancing.** No per-pixel hard classes (they
speckle and don't blend), no networked instances (they don't scale).

---

## The three-layer data flow

```
  SERVER (flaskserver, Python, per tile)          CLIENT (webserver, per tile on load)
  ┌───────────────────────────────────┐           ┌────────────────────────────────────┐
  │ inputs: texture(SPOT summer) +     │           │ fetch fields raster for tile       │
  │ ArcticDEM heightmap + landcover    │  fields   │ deterministic scatter:             │
  │ priors (WorldCover/CAVM)           │ ────────▶ │  for each candidate cell:          │
  │                                    │  (small   │   sample fields (bilinear)         │
  │ → FIELDS (continuous 0..1 rasters):│  raster   │   density = Σ species rules        │
  │   veg, rock, snow, water,          │  per tile)│   hash(tileId,cell) picks species  │
  │   moisture, slope, southness,      │           │   place + jitter + scale + yaw     │
  │   altitude, + community weights    │           │ → InstancedMesh per species + LOD  │
  └───────────────────────────────────┘           └────────────────────────────────────┘
       cached in terrain.db like heightmap/texture       pure fn of (tileId, pos) ⇒ every
       served: GET /api/fields/<tile_id>                 client identical, zero sync
```

**Why this shape:** the server computes cheap smooth **fields** (not instances);
the client turns fields → thousands of instances **locally and identically**.
Multiplayer determinism is free because placement is a pure function of
`(tileId, world position)` — the server never tracks a single plant.

---

## The per-tile field set (what the server ships)

Small continuous rasters per tile (64×64 or 128×128 is plenty — these are smooth;
a d12 tile is ~660 m, so 128² ≈ 5 m/texel, finer than the placement needs). Pack
as one multi-channel blob per tile. Each channel is 0..1 (or −1..1 for southness).

| field        | 0..1 meaning                    | source (all already available)                                    |
|--------------|---------------------------------|-------------------------------------------------------------------|
| `veg`        | vegetation strength             | texture green-excess — `guide_assets.classify()` returns this `veg` weight today |
| `rock`       | bare rock / scree strength      | texture (grey/bright, low green) × high slope × low veg           |
| `snow`       | snow / ice                      | texture (bright + desaturated) × altitude                         |
| `water`      | open water                      | texture (dark/blue, flat) or the existing SAM water mask          |
| `moisture`   | wetness (hollows, flow, low)    | DEM — low-vs-neighbourhood + low slope + flow accumulation        |
| `slope`      | steepness                       | DEM gradient — `training_data.terrain_channels()` `slope`         |
| `southness`  | −1 N-facing … +1 S-facing (warmth/sun) | DEM aspect — `terrain_channels()` `southness`             |
| `altitude`   | normalized elevation (zonation) | DEM `elev`                                                        |
| `comm[k]`    | community-prior weights (few)   | WorldCover/CAVM → `greenland-communities.toml` ids, reprojected to the tile |

`veg`/`rock`/`snow`/`water` come from the **summer texture** (where plants show).
`moisture`/`slope`/`southness`/`altitude` from the **DEM**. `comm[k]` is the
**land-cover prior** — the species vocabulary (which community, hence which plants
are plausible), NOT optional. These fields BLEND; nothing is thresholded into a
hard class, so no speckle.

---

## Per-species density rules (the "scatter network")

Each asset is a density = product of field terms in [0,1], plus a calibration
constant `D0` (target instances / 100 m² for that species, MEASURED by
`guide_assets` on real tiles). Helpers are smoothsteps over fields:

```
warmth(x)   = smoothstep(-0.3, 0.6, southness) * smoothstep(600, 0, altitude_m)
shelter(x)  = smoothstep(0.5, 0.12, slope) * (0.4 + 0.6*moisture)
exposed(x)  = smoothstep(0.1, 0.5, slope) * smoothstep(0.3, -0.2, southness)
belowCliff(x) = local upslope steepness (scree collects under cliffs)
```

Plants (density scaled by `veg`, killed by snow/water/rock):

```
dwarf_birch = D0_birch * veg * shelter * warmth * comm[shrub_heath] * (1-snow)*(1-water)
crowberry   = D0_crow  * veg * comm[dwarf_shrub_tundra] * (1-warmth*0.3)          # tolerates cold/exposed
cottongrass = D0_cott  * veg * smoothstep(0.5,0.9,moisture) * comm[mire]           # wet only
cushion     = D0_cush  * clamp(veg*0.5+0.2) * exposed * smoothstep(400,900,altitude) * comm[fell_field]
niviarsiaq  = D0_niv   * veg * warmth * comm[meadow]                               # sparse dots
```

Rocks (driven by `rock` + DEM, independent of `veg`):

```
boulder = D0_boul * rock * smoothstep(0.2,0.6,slope) * (1 + belowCliff)   # size ∝ slope too
scree   = D0_scr  * rock * smoothstep(0.35,0.7,slope)                     # dense small stones on steep bare
gravel  = D0_grv  * rock * (1-slope) * moisture                           # outwash / stream bars (flat, wet)
```

These rules are the whole "art-directable" surface — tune constants, add species,
never touch the scatter engine. This is exactly a UE5-PCG graph / Houdini scatter
network, written as plain functions.

---

## Deterministic scatter (client, multiplayer-safe)

Per tile, walk a candidate grid (cell size = target spacing, e.g. 1–2 m). For
each cell, everything derives from one hash so all clients agree:

```
seed  = hash3(tileId, cellX, cellY)               # integer, deterministic
pos   = cellCenter + (hash2(seed)-0.5) * cellSize  # jitter within cell
f     = sampleFields(pos)                          # bilinear from the tile raster
dens  = { s: rule_s(f) for s in species }          # per-species density here
total = Σ dens
if rand01(seed) > total: continue                  # empty cell (bare ground)
species = weightedPick(seed, dens)                 # cumulative over dens
yaw   = rand01(seed>>8) * 2π
scale = lerp(sMin_species, sMax_species, rand01(seed>>16))
emit(species, pos, yaw, scale)
```

Pure function of `(tileId, cell)` ⇒ identical on every client, no networking of
instances. Density conservation: near/far use the same rule, far just samples a
coarser cell grid (fewer, wider) — the LAAS grass trick.

---

## LOD & instancing (client)

- One `InstancedMesh` per species per tile; near ring = real mesh (lod0 ≤ ~200
  tris), mid = low-poly (lod1 ≤ ~50), far = quad billboard, then cull.
- Per-instance hue/scale jitter via instance attribute (keeps batching).
- Tie into the existing tile lifecycle: build on tile load, dispose buffers on
  tile drop (zero attributes then `.dispose()`), under a `scatterRoot`.
- Asset meshes are procedural GLBs per species (WORKLIST `webserver/tools/generate_*_glb.mjs`).

---

## Where each piece runs / what we reuse

| piece | home | status |
|---|---|---|
| field computation (texture veg, DEM channels, landcover reproject) | `flaskserver` new module | veg via `guide_assets.classify()`, DEM via `terrain_channels()` — exist; add rock/snow/water/moisture + landcover fuse |
| `GET /api/fields/<tile_id>` (packed raster, cached in db) | `flaskserver/serve_flask.py` | new endpoint (mirror heightmap/texture caching) |
| density rules + deterministic scatter | `webserver/procgen/scatter.ts` | exists (246 lines) — the target for the rules + hash scatter |
| per-species GLB generators | `webserver/tools/` | WORKLIST tasks |
| calibration constants `D0`, size ranges | offline | `guide_assets` `bush_stats`/`boulder_stats`/`scree_stats` MEASURE these on sample tiles |

`guide_assets` flips role: not a classifier, a **calibrator** — measure real bush
and boulder densities/sizes on representative tiles, bake the numbers into the
rule constants so the procedural world matches reality.

---

## Physics / collision — lightest tool per need (NOT a physics engine by default)

"Can't walk through a tree" is a **collision query**, not rigidbody dynamics, so a
full solver is the wrong default. Because scatter is deterministic and every
instance's `(pos, scale)` + a simple proxy is already known, most collision is cheap
analytic math. Tier up only when a need demands it:

| need | tool (lightest that works) |
|---|---|
| stand on / walk terrain | **analytic heightfield sample** from the DEM (height + normal at player xz). No BVH, no engine. |
| don't walk through trees/rocks | **analytic capsule-vs-proxy** — push the player out of nearby trunk **cylinders** / rock **spheres**. Distance math over the few near instances. |
| mesh-accurate rays (shooting, LOS, projectile hit-test) | **three-mesh-bvh** — query-only BVH, far lighter than a solver. |
| real dynamics (vehicles w/ suspension, tumbling debris, ragdolls) | **Rapier** (`@dimforge/rapier3d-compat`) — only for *those* bodies, not the static world. |

Default = analytic (+ BVH for accurate rays) for the whole static world; **Rapier
deferred** to dynamics. The framerate win: no WASM solver stepping thousands of
static colliders each frame. Solver cost scales with what's **moving**, not world size.

Determinism keeps it sync-free: the static collision world is regenerated locally
per client (same fields, same hash), so it's never networked. Collision follows the
player — only near-tile instances get proxies (same lifecycle as visuals). Proxies
come from the same `(species, pos, scale, yaw)` the scatter emits, so collision ⇄
visual always match.

## Destruction (three-pinata + Rapier) — for the military/economic sim

Destroyable buildings / projectile impacts use a fracture lib + the solver, each one
job:

- **`three-pinata`** (Voronoi fracture, mesh-only, **seeded**) cuts a mesh into
  fragments. No physics of its own.
- On a projectile **ray-hit** (BVH) against a building: fracture it (seed = impact
  point + shared world seed → identical fragments on every client) → spawn the
  fragments as **Rapier** dynamic bodies → they fall → **settle → freeze into static
  rubble** (drop out of the solver) → despawn tiny bits. Refracture = progressive damage.
- **Perf**: the solver only ever holds the *currently* shattering building + active
  debris + vehicles + projectiles. Pre-fracture complex buildings **offline** (bake
  chunks) to avoid mid-frame Voronoi hitches — cheapest and fully deterministic.

## Networking & object tracking — memory for *now*, DB for what *persists*

Real-time state lives in **server memory**, not a DB (a DB is far too slow for
30–60 Hz positions). Model = **authoritative server**: clients send **inputs**, the
server simulates the truth in memory and broadcasts **snapshots/deltas**; clients
**predict** their own motion, **interpolate** others, **reconcile** on correction;
**area-of-interest** filtering sends each client only nearby entities. Transport:
**WebSocket** to start, **WebRTC** for twitch action.

**Track only deviations from the deterministic world.** Trees/rocks are implicit
(`tileId`+hash) — never stored or synced. An object gets a unique **entity id** +
tracked state only when it's inherently dynamic (players, vehicles, projectiles) or
**deviates** (a destroyed building, a chopped tree). Store the **delta**, tiny:
`{tile, instance:47, state:"removed"}` / `{building:"B_912", state:"destroyed", seed}`.

| data class | home | how |
|---|---|---|
| terrain, plants, rocks (+ their collision) | none — client-generated | deterministic; not stored, not synced |
| players, vehicles, projectiles | server **memory** (Redis if multi-process) | tick + broadcast, prediction/interp, AOI-filtered |
| destroyed buildings, economy, ownership | memory **+ Postgres** | authoritative event → broadcast + persist; reload on restart |
| player position at logout/checkpoint | **Postgres** | periodic snapshot, not per-frame |

Keep the game-state DB **separate from `terrain.db`** (that's static terrain/asset
caching — a different concern). Tracked-object count ≈ dynamic entities + player-
caused deltas — never the millions of procedural trees.

Where it runs: **client** owns collision + local dynamics; **real-time server**
(memory + Redis) owns authoritative live state; **Postgres** owns persistence.
The field server ships only fields — it never touches live game state.

## Build order (each step ships something visible)

1. **Fields on the server** — compute the field set for a tile from texture+DEM
   (landcover fuse can be a constant prior first), render a QA composite, eyeball
   on real tiles. Reuses `classify()` veg + `terrain_channels()`.
2. **`/api/fields/<tile_id>`** — cache + serve the packed raster.
3. **Scatter in `scatter.ts`** — 2–3 species (dwarf birch, crowberry, boulder)
   with density rules + deterministic hash scatter; instance + LOD on tile load.
   Collision = **analytic** ground (DEM height sample) + capsule-vs-proxy over
   near-tile trunks/rocks (no engine yet); a character that can't walk through
   trunks is the visible proof. Rapier/destruction come later, with dynamics.
4. **Calibrate** `D0`s with `guide_assets` on sample tiles; add species.
5. Iterate: the rules are the only thing you touch to change the world.
