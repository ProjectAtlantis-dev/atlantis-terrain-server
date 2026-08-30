# Terrain Port: Testable MVP Staircase

This plan refines the broad Flask migration work packages into independently
executable Atlantis increments. `serve_flask.py` remains the behavior guide,
but no increment waits for the entire Flask request graph to be ported.

The first objective is not camera demand. It is two small, callable vertical
paths:

1. acquire, persist, and read one DEM tile;
2. acquire, persist, and read one texture tile.

## Rules for every increment

- The module must import in the Atlantis virtualenv before the increment is
  considered complete.
- Every increment gets an offline deterministic test before any live-provider
  smoke test.
- Provider fetch, decoding, persistence, and tool exposure are separate gates.
- All database work uses the single connection owned by
  `Terrain/Database/database.py` in `atlantis.server_shared`.
- No helper may open a second SQLite connection.
- Later dependencies stay absent or commented; do not install no-op scheduler
  shims that make unfinished behavior look successful.
- A failed fetch must not overwrite an existing valid payload.
- ArcticDEM must be converted from WGS84 ellipsoidal heights to orthometric
  EGM2008 heights before persistence. Acquisition fails closed when PROJ's
  `us_nga_egm08_25.tif` grid is unavailable; its zero-offset ballpark
  transformation is not valid terrain data.
- Camera position, LOD traversal, retries, queues, coastline composition,
  bathymetry, seams, and classifiers are explicitly outside this MVP.

Run the deterministic offline suite through the connected Atlantis command
surface with:

```text
%brickhouse/terrain/Terrain/Test/terrain_regression
```

## Completed foundation

### Step 0: Shared database connection

Status: complete.

- `Database/database.py` owns one reload-safe connection in
  `atlantis.server_shared`.
- Connection setup applies a 30-second timeout, `busy_timeout=30000`, WAL,
  `synchronous=NORMAL`, and foreign keys.
- The connection is eligible for future scheduler threads, but no scheduler is
  part of the MVP.

Gate:

- Two calls to `db()` return the same object.
- Required pragmas have their expected values.
- No active terrain module calls `sqlite3.connect()` outside the connection
  owner.

### Step 1: Tile configuration and addressing

Status: complete.

- Canonical EPSG:3413 root bounds and depth contracts are present.
- Tile IDs parse, format, and resolve to exact bounds.

Gate:

- Root, four children, known production IDs, malformed IDs, negative IDs, and
  out-of-range addresses match the Flask behavior.

### Step 2: Skeleton and metadata storage

Status: complete.

- Empty tile skeletons can be seeded.
- Metadata can be written and read.
- Geometric-error calculation matches Flask when NumPy is available.

Gate:

- Seeding through depth 2 creates exactly 21 rows with exact parent links and
  bounds.
- Re-seeding is idempotent.
- No provider or network code runs.

## DEM vertical path

### Step 3: Coordinate conversion

Status: complete.

Deliverable:

- Port only the EPSG:4326/EPSG:3413 transforms needed by DEM acquisition.

Offline gate:

- Known latitude/longitude and stereographic points match Flask within the
  existing numerical tolerance.
- No database or network access occurs.

### Step 4: ArcticDEM request construction

Status: complete.

Deliverable:

- Given one tile ID, determine its ArcticDEM source request without opening
  the network.
- Represent the request as plain data that a test can inspect.

Offline gate:

- Known tile `10-334-192` produces the expected bounds, dataset selection,
  intersecting COG URL, CRS, and output grid size.
- An invalid tile fails before provider code runs.

### Step 5: DEM fixture decoding

Status: complete.

Deliverable:

- Decode a small checked-in or generated raster fixture into the canonical
  65-by-65 float32 heightmap.
- Keep provider I/O injectable so the test never contacts the network.

Offline gate:

- Exact shape and dtype.
- Expected extrema and NaN mask.
- Deterministic decoded digest.
- Corrupt and empty fixtures return explicit outcomes rather than partial
  arrays.

Validated with the EGM2008 correction at the requested tile's center. For
`10-334-192`, geoid undulation is `28.601763177120265` metres; the corrected
fixture digest is
`a281369d5aca9740d5a7805c39c168e0904475556aaa340c2064da050becc902`.
The MCP environment raises an explicit configuration error rather than using
PROJ's zero-offset fallback when the geoid grid is absent.

### Step 6: One live ArcticDEM fetch

Status: complete.

Deliverable:

- A hidden/internal function fetches `10-334-192` and returns decoded metadata
  without writing the database.

Live gate:

- One request completes with provider identity, shape, extrema, NaN count,
  and digest.
- Repeating the request yields an equivalent decoded contract.
- Network errors are returned as errors, not `no_data`.

Validated with `10-334-192`: the live read applied EGM2008 geoid undulation
`28.601763177120265` metres and returned a 65-by-65 float32 grid,
-0.28145408630371094 through 15.582735061645508, zero NaNs, and digest
`b47363d6d59b32c8bf84d5675a81b19250293ea9b2d8d5a55ddac60a5ca73ec2`.

Stop here if live provider access is not proven. Persistence must not hide a
broken acquisition path.

### Step 7: DEM persistence

Status: complete.

Deliverable:

- Compress and store one decoded DEM through the shared connection.
- Record source, confidence, geometric error, and timestamps.

Offline gate:

- Store and read-back reproduce the exact float32 array and confidence map.
- Repeating the identical write is idempotent.
- A different payload raises the no-clobber error.
- A simulated failed acquisition leaves a valid existing row unchanged.

Validated through the shared connection with a rollback-only corrected fixture
check: the first write succeeded, the identical write was idempotent, exact
float32 data, confidence, and `EGM2008` vertical-datum provenance were
recovered, changed payloads were blocked, and failed input preserved the
existing payload.

### Step 8: Callable DEM MVP

Status: complete.

Deliverable:

- Atlantis tool `fetch_dem(tile_id: str)` composes Steps 4-7.
- Atlantis tool `read_dem(tile_id: str)` reports stored metadata and digest.

End-to-end gate:

- Starting from an empty payload row, `fetch_dem("10-334-192")` acquires and
  stores the tile.
- `read_dem("10-334-192")` reports the same source, extrema, NaN count,
  geometric error, and digest.
- No LOD, scheduler, coastline, texture, or bathymetry work is triggered.

Validated end to end with `10-334-192`: `fetch_dem` stored the live,
EGM2008-corrected ArcticDEM grid with source `arcticdem_10m`, vertical datum
`EGM2008`, confidence level 6, geometric error 9.708001136779785, and digest
`b47363d6d59b32c8bf84d5675a81b19250293ea9b2d8d5a55ddac60a5ca73ec2`.
An independent `read_dem` recovered the same persisted contract, and a repeat
`fetch_dem` was idempotent with `written: false`.

This is **MVP-A**. It is useful on its own.

## Texture vertical path

### Step 9: Dataforsyningen request construction

Status: complete.

Deliverable:

- Given one tile ID, construct the aligned WMS/metatile request as plain data
  without opening the network.

Offline gate:

- Known tile `10-328-212` produces the expected layer, CRS, bounds,
  dimensions, and child offsets.
- Request construction has no database side effects.

Validated with `10-328-212`: it resolves to metatile `8-82-53`, EPSG:3413
bounds `[-374197.75, -2787093.125, -363650.875, -2776546.25]`, padded
EPSG:3184 WMS bounds, a 1024-by-1024 two-layer request, and the exact sixteen
256-pixel child offsets with north/south image-row inversion. Database counts
remained one DEM row and zero texture rows.

### Step 10: Texture fixture decoding and splitting

Status: complete.

Deliverable:

- Decode a fixture JPEG/PNG and split the aligned metatile into exact child
  images.

Offline gate:

- Exact child IDs, dimensions, orientation, and crop bounds.
- Stable decoded pixel or perceptual digests.
- White/no-coverage and corrupt responses are distinct outcomes.

Validated with a deterministic 1024-by-1024 north-up PNG: all sixteen child
IDs, 256-pixel dimensions, inverted row crops, and expected center colors
passed. The stable combined child digest is
`c576c13ebfd8a1151652c2edd8393e483c1d1033a04fbe245a7142dc387da39f`;
white-fill reports `white_fill`, while undecodable bytes report `corrupt`.

### Step 11: One live Dataforsyningen fetch

Status: complete.

Deliverable:

- A hidden/internal function fetches one known metatile and returns decoded
  metadata without persistence.

Live gate:

- One request returns provider status, image dimensions, content length, and
  digest.
- Authentication, rate limiting, no coverage, and operational failure remain
  distinguishable.

Validated live with `10-328-212`: Dataforsyningen returned HTTP 200 JPEG data,
which reprojected to a 1024-by-1024 PNG with imagery coverage, 0.08955 percent
warp void, and digest
`cdf0488f33db930659819e1eb7a48ecc74ccf0f91cb6fd4936be52e6a51474e0`.
The fetch left database counts at one DEM row and zero texture rows. A missing
credential raises a configuration exception; authentication errors, rate
limiting, transient/provider errors, network errors, corrupt responses, and no
coverage have distinct provider outcomes.

### Step 12: Texture persistence

Status: complete.

Deliverable:

- Store exact child JPEGs through the shared connection.

Offline gate:

- Every child reads back byte-for-byte.
- Sibling writes are atomic from the caller's perspective.
- Identical writes are idempotent.
- Failed or partial metatiles do not clobber valid children.

Validated through the shared Atlantis connection with a rollback-only fixture
check: all sixteen child JPEGs read back byte-for-byte, the identical sibling
write was a no-op, changed and incomplete sets were rejected without altering
valid rows, and an injected SQLite failure left no partial siblings. The
texture table returned from zero rows to zero rows after the savepoint rollback.

### Step 13: Callable texture MVP

Status: complete.

Deliverable:

- Atlantis tool `fetch_texture(tile_id: str)` composes Steps 9-12.
- Atlantis tool `read_texture(tile_id: str)` returns stored bytes or a client
  image plus provenance metadata.

End-to-end gate:

- Starting with no texture row, `fetch_texture("10-328-212")` acquires and
  stores the expected sibling set.
- `read_texture("10-328-212")` returns the stored exact tile.
- No DEM, LOD, scheduler, classifier, or coastline work is triggered.

Validated end to end with `10-328-212`: `fetch_texture` acquired and
atomically stored the sixteen aligned Dataforsyningen children, and an
independent `read_texture` returned the requested tile's exact JPEG bytes with
matching provenance, content length, and digest. No DEM, LOD, scheduler,
classifier, or coastline work was triggered.

This is **MVP-B**. It is independently useful.

## Post-MVP composition, not prerequisites

Only after MVP-A and MVP-B pass independently should work proceed. The
remaining migration is governed by the final delivery contract:

> `/api/tiles` performs bounded local reads and composition, submits missing
> work without waiting, and immediately returns the best coherent terrain
> already available.

The interactive path must never perform provider I/O, wait on a worker or
future, sleep for backoff, or hold a database transaction while acquisition or
decoding runs. A missing or slow DEM, texture, coastline, hydrography, or
auxiliary source must degrade only its own response field. It may not suppress
another ready domain or delay final delivery.

Provider acquisition and decoding happen outside database transactions.
Successful publication uses a short transaction only after the complete
payload has been validated. Independent work lanes must retain independent
capacity and retry state so one failing provider cannot occupy every worker or
starve another domain.

Cross-tile tidal-connectivity derivation is also outside the interactive path.
The completed explicit derivation tool remains the correctness oracle, but the
mother path may consume only an already-ready connectivity snapshot/cache. A
missing snapshot falls back to currently authoritative data and reports the
derivation as pending; it does not compute an unbounded same-depth flood before
responding.

With that contract fixed, work proceeds in this order:

1. explicit parent fallback for a requested tile (**complete**);
2. explicit coastline-mask acquisition for a requested tile (**complete**);
3. explicit WMS hydrography acquisition for a requested tile (**complete**);
4. same-depth tidal-connectivity derivation (**complete**);
5. coastline-aware effective heightmap derivation (**complete**);
6. read-only multi-tile composition from already-ready data (**complete**);
7. binary batch response compatibility (**complete**);
8. pure LOD traversal for a supplied camera (**complete**);
9. independent nonblocking demand lanes, including off-path connectivity
   (**complete**);
10. latest-camera prioritization of unstarted work (**complete**);
11. bounded retries inside the background lanes (**complete**);
12. polling and visible-footprint convergence (**complete**);
13. viewer HTTP compatibility for `/api/tiles` and `/api/texture/<id>.jpg`
    (**complete**);
14. bathymetry, classifiers, buildings, diagnostics, and other auxiliary
    surfaces.

Each item remains a separate callable and test gate. Passing a later gate may
not be used as evidence that an earlier acquisition or persistence step works.
Every composition, traversal, scheduling, and retry gate must additionally
prove that unavailable work in one domain cannot withhold ready output from
another.

### Post-MVP Step 1: Explicit parent fallback

Status: complete.

- `read_dem_fallback(tile_id)` and `read_texture_fallback(tile_id)` prefer an
  exact stored payload, otherwise return the nearest stored ancestor with its
  resolved tile ID and depth delta.
- Fallback reads expose stored source bytes/arrays without creating derived
  crops, resamples, demand, or database writes.
- The rollback-only offline gate covers exact precedence, nearest-ancestor
  resolution, clean misses, and read-only behavior for both domains.

Validated through the live MCP surface: DEM child `11-668-384` resolved to
EGM2008 parent `10-334-192` with depth delta 1 and digest
`b47363d6d59b32c8bf84d5675a81b19250293ea9b2d8d5a55ddac60a5ca73ec2`;
texture child `11-656-424` resolved to Dataforsyningen parent `10-328-212`
with depth delta 1 and digest
`b09509b6772b83a0aeff7a04dfb0c38341831b553c3b01c5a20caf990d9ad25c`.
Calling both parent IDs directly returned `exact: true` and depth delta 0.

### Post-MVP Step 2: Explicit coastline-mask acquisition

Status: complete.

- `coastline_request(tile_id)` derives the required GTK50 provider blocks
  without network or database access.
- `fetch_coastline(tile_id)` downloads missing immutable GeoPackages into an
  ignored source cache, rasterizes `tidalwater_s` minus `island_s`, and stores
  the south-first 65x65 authoritative sea mask.
- `read_coastline(tile_id)` independently verifies the persisted source,
  version, dimensions, water/land counts, and digest.
- Acquisition and rasterization finish before the terrain database is opened;
  persistence is idempotent and refuses to clobber different source data.

Validated through the live MCP surface with `10-334-192`: block `71_-2`
produced 4,001 water vertices and 224 land vertices, matching the Flask mask
digest exactly:
`afd1c6023b70b9c845e6a409c8b4c6094f1d8e78eeec47e25b253f4bd54d6344`.
An independent read returned source `gtk50_vector`, version 2, and shape
65x65. Rendered-WMS hydrography remains a separate, unported post-MVP surface.

### Post-MVP Step 3: Explicit WMS hydrography acquisition

Status: complete.

- `hydrography_request(tile_id)` constructs the Government of Greenland
  `Greenland:gl_aabent_land` WMS request without network or database access.
- `fetch_hydrography(tile_id)` fetches the 8x-oversampled render, classifies
  its blue water cartography, aggregates it to a south-first 65x65 mask, and
  persists that raw hydrography source without deriving tidal authority.
- `read_hydrography(tile_id)` independently returns the exact stored source,
  version, dimensions, counts, and digest.
- Provider acquisition and decoding finish before the shared terrain database
  is opened. Identical writes are idempotent; different payloads are refused,
  and failed acquisitions cannot alter a valid row.

Validated through the live MCP surface with `10-334-192`: the WMS returned a
520x520 PNG whose decoded 65x65 mask contained 4,086 water samples and 139
land samples. The new decoder matched Flask exactly with digest
`64865f07364f6501da6d0807b0944bf559d047841e79b4276036180f63275ca6`.
The first callable fetch wrote source `govmin_gl_aabent_land` version 1, an
independent read recovered the same contract, and a repeat fetch was
idempotent with `written: false`. Tidal connectivity and effective-heightmap
derivation remain separate, unported steps.

### Post-MVP Step 4: Same-depth tidal-connectivity derivation

Status: complete.

- `derive_tidal_connectivity(tile_id)` labels WMS hydrography with
  four-neighbour topology, joins components only across exact shared samples
  at the same tile depth, and floods them from trusted GTK50 coastline edges.
- A DEM grants sea-seed authority only when every finite sample in its entire
  tile is at or below 0.5 metres. One low creek or lake sample inside an
  otherwise elevated tile does not seed its component.
- The derivation is read-only and returns raw, connected, and rejected counts
  plus a deterministic connected-mask digest. It neither persists a derived
  mask nor changes the canonical DEM.
- `preview_coastline(tile_id)` renders authoritative coastline in pink,
  `preview_hydrography(tile_id)` renders raw WMS water in blue, and
  `preview_tidal_connectivity(tile_id)` overlays accepted tidal water in pink
  over the raw blue mask.

The rollback-only topology gate covers same-tile coastline seeding, flood
propagation across a shared tile edge, neighbour-coast seeding, disconnected
inland rejection, whole-tile 0.5-metre seeding, and rejection when only one
sample is low. Its combined digest is
`c55d7a51b88b997d5b1a3a553b738194a48f2a8d6630fc51f28fd2e431dba63d`.
The live MCP derivation for `10-334-192` accepted all 4,086 WMS samples, and
all three preview tools emitted their 520x520 images successfully.

At completion of Step 4, `Test/terrain_regression` ran all ten deterministic
Terrain gates in one call. The complete suite passed both in an isolated
database and through the live MCP surface before effective-heightmap work
began.

### Post-MVP Step 5: Coastline-aware effective heightmap derivation

Status: complete.

- `derive_effective_heightmap(tile_id)` unions exact authoritative GTK50 sea
  with same-depth tidally connected WMS hydrography and applies the result to
  the exact canonical DEM as a derived read view.
- Effective water receives the Flask-compatible 5 m fallback floor plus 1 m
  shoreline seafloor separation. When no effective mask exists, nonpositive
  canonical DEM samples retain the legacy water fallback; rejected inland WMS
  hydrography does not suppress it.
- An exact coastline clips stale nonpositive derived geometry on authoritative
  land to sea level. All-water masks can synthesize a render heightmap without
  a DEM, while mixed masks still require canonical terrain.
- Derivation is read-only: it neither stores an effective mask nor rewrites the
  canonical DEM. Shape mismatches fail closed rather than applying a shifted
  or partial mask.

The rollback-only effective-heightmap gate covers coastline/connected-water
union, disconnected inland rejection, fallback floor and shoreline drop,
stale-water clipping, measured-land preservation, canonical DEM immutability,
no-mask DEM fallback, no-DEM all-water synthesis, mixed-mask rejection, and
shape safety. Its fixture heightmap digest is
`b5cc9773ae4d745c4214e30996ce608670f990a096a936c5031043719fcbccc4`.

Validated through the live MCP surface with `10-334-192`: 4,094 effective
water samples and 131 land samples produced a 65x65 float32 EGM2008 view with
a -6 m fallback seabed and digest
`140096349be9ca6c00a32ba62e774ebb14493f4c723d5f6399e94f3ce39881fd`.
An independent `read_dem` still returned the original canonical digest
`b47363d6d59b32c8bf84d5675a81b19250293ea9b2d8d5a55ddac60a5ca73ec2`.

At completion of this step, `Test/terrain_regression` ran all eleven
deterministic Terrain gates in one call. The complete suite passed both against
a disposable database copy and through the live MCP surface before read-only
multi-tile composition began.

### Remaining delivery staircase

#### Post-MVP Step 6: Read-only multi-tile composition

Status: complete.

- Accept explicit tile IDs and return every independently available domain.
- Prefer exact DEMs and textures, then report their nearest stored ancestors.
- Compose effective heightmaps only from already-ready water state.
- Return explicit missing/pending state without network access, scheduling,
  database writes, or suppression of ready sibling/domain results.

The replacement service now exposes `compose_tiles(tile_ids)` for bounded,
explicit batches. DEM and texture fallback resolve independently, effective
heightmaps consume only exact coastline data and already-published tidal
connectivity snapshots, and raw hydrography without a snapshot is reported as
pending rather than derived in the call. Per-domain exceptions are returned as
domain-local errors so a corrupt or unavailable DEM cannot suppress a ready
texture, and vice versa.

The rollback-only composition gate covers input ordering, DEM and texture
ancestor fallback, texture-only and DEM-only delivery, pending versus ready
tidal connectivity, per-domain error isolation, clean misses, a trapped HTTP
client, and unchanged SQLite write counts. The live MCP invocation now passes:
`compose_tiles(["10-334-192", "10-328-212"])` returned both requested tiles,
kept DEM and texture availability independent, and reported the unpublished
tidal-connectivity snapshot as pending without deriving it in the call.

#### Post-MVP Step 7: Binary batch compatibility

Status: complete.

- Encode the Step 6 result using the browser's aligned `binary-v1` contract.
- Honor known heightmap digests so resident geometry can be reused without
  retransmitting or reallocating its samples.

`compose_tiles_binary(tile_ids, known_digests)` now encodes the read-only Step
6 result as a four-byte little-endian header length, padded JSON header, and
ordered float32 sample blocks. Heightmap identity uses the browser-compatible
CRC32 of the exact effective bytes. Matching residency digests set
`heightmapBytes` to zero and omit the block; embedded DEM and texture base64 is
removed from the header. A corrupt heightmap becomes a DEM-local error without
suppressing another tile or its texture.

The deterministic binary gate covers alignment, browser field names, block
order, exact independent-encoder parity, stable digest, residency reuse,
missing data, corruption isolation, input immutability, and invalid digest
validation. Its payload digest is
`09a8408a25c1444ccf879a031a187505d875e3d90e54cfdc5a355f1690fe3498`.
The live two-tile call produced an 18,540-byte envelope with one 16,900-byte
65x65 heightmap; repeating it with digest `aee8820b` produced a 1,636-byte
metadata-only envelope and `tilesReused: 1`. The repository's actual browser
decoder recovered all 4,225 samples, and all thirteen deterministic Terrain
gates pass through the live MCP surface.

#### Post-MVP Step 8: Pure supplied-camera LOD

Status: complete (server-side).

- Convert a supplied camera into visible and missing tile IDs without provider
  access.
- Return the best stored ancestor coverage while finer candidates are absent.

`camera_lod.py` now ports the Flask radial-distance, past-contract core, and
AGL altitude-cap rules into a deterministic traversal driven only by supplied
EPSG:3413 camera values. The desired leaf set is bounded at 2,500 entries,
sorted deterministically, and refined on the coarse side until every adjacent
transition satisfies the viewer's 2:1 quadtree constraint. Selection performs
no database, provider, network, or scheduler work.

The read-only coverage phase resolves each desired leaf to its nearest ready
DEM ancestor with bulk SQLite reads, then collapses overlapping fallbacks into
a coherent antichain. Missing exact targets remain explicit as `fallback` or
`missing`. `compose_camera_binary(...)` composes the non-overlapping ready
coverage in bounded chunks and emits the Step 7 `binary-v1` envelope with
origin-relative ready and missing bboxes, absolute `stereoBbox` metadata, and
the existing viewer field names.

The fourteenth deterministic Terrain gate covers every Flask depth boundary,
depths 13-16 inner cores, altitude and hysteresis behavior, a stable 259-leaf
selection, 2:1 balancing, coherent ancestor fallback, true misses, camera
geometry, missing-tile viewer fields, binary layout, invalid input, and zero
database/network/scheduler side effects. All fourteen server-side gates pass.
No browser is part of this step; live viewer testing begins only after demand,
retry, convergence, and HTTP compatibility are implemented in Steps 9-13.

#### Post-MVP Step 9: Independent nonblocking demand

Status: complete (server-side).

- `demand.py` owns separate bounded lanes for DEM (4 workers), texture (2),
  coastline (1), hydrography (1), and tidal connectivity (1). Each lane has
  its own active and userspace-pending sets, so provider latency or failure in
  one domain cannot consume another domain's capacity.
- Camera submission performs bounded ready-state reads, coalesces duplicate
  work, and returns without waiting for workers. Imagery is deduplicated by
  aligned 4x4 metatile. Water work is normalized to the depth-12 WMS contract
  and staged behind ready DEM coverage; connectivity is staged behind ready
  hydrography and derived outside the camera path.
- Provider acquisition and decoding occur before the shared database is
  touched. Successful publication uses a short serialized section on the one
  `server_shared` connection. Failed work is held rather than hot-looped;
  retry classification and deadlines remain Step 11.
- Connectivity queue identity includes the current missing-row generation, so
  new same-depth hydrography can schedule a later snapshot pass after an
  earlier pass has completed.

The fifteenth deterministic Terrain gate deliberately blocks one lane while
another finishes, proving immediate submission, independent capacity, bounded
activity, deduplication, failure isolation, no hot loop, and clean shutdown.
A rollback-only database fixture additionally proves dependency staging,
fallback-coverage inclusion, texture metatile coalescing, connectivity
generation keys, and zero writes during candidate discovery. All fifteen
server-side gates pass.

#### Post-MVP Step 10: Latest-camera prioritization

Status: complete (server-side).

- Replace obsolete unstarted work with the newest nearest-first camera demand;
  already-running work may finish without holding the response open.

Every lane now keeps provider work outside the executor until a capacity slot
is available. A camera refresh atomically replaces only that userspace pending
queue, drops obsolete IDs, retains still-visible IDs without duplication, and
orders desired leaves by camera distance. Ready fallback coverage inherits the
priority of its nearest desired descendant. Active work is never cancelled and
may publish normally, but it cannot cause stale queued work to run afterward.

The sixteenth deterministic Terrain gate blocks one active old-camera item,
replaces its pending siblings, and proves the active item finishes followed by
the new nearest-first order. It also locks deterministic desired-leaf and
fallback-coverage priority ordering. All sixteen server-side gates pass.

#### Post-MVP Step 11: Bounded background retries

Status: complete (server-side).

- A worker performs one provider attempt, records a bounded retry deadline,
  releases its slot, and becomes eligible on a later scheduler pass.
- No worker sleeps while occupying capacity, and no retry runs inside
  `/api/tiles`.
- Credentials, invalid payloads, dimensions, and clobber conflicts fail
  terminally; only classified transient failures are retried.

Each lane now records at most two retry deadlines (2 seconds, then 10 seconds)
after transport, timeout, rate-limit, or provider-server failures. No timer or
worker sleeps: eligibility is checked on a later camera refresh, after the
failed attempt has already released capacity. HTTP credential/not-found
responses, missing credentials, invalid inputs or decoded payloads, dimension
errors, clobber conflicts, unknown failures, and exhausted attempts remain
terminal.

The seventeenth deterministic gate drives a fake clock through early,
eligible, successful, terminal, and exhausted cases. It proves exact
deadlines, no early retry, bounded eventual success, terminal exclusion, and a
0.008 ms non-sleeping refresh. All seventeen server-side gates pass.

#### Post-MVP Step 12: Polling and convergence

Status: complete (server-side).

- Responses distinguish actionable work, active work, and future retry times
  so the browser polls only when useful.
- Repeated polls monotonically improve the visible footprint while continuing
  to deliver the best available fallback on every response.

Camera-demand responses now distinguish active/pending work (`poll`), a future
retry deadline (`retry` plus `retryAfterMs`/`nextRetryAt`), and a terminal or
complete view (`idle`). Only failures claimed by the latest camera influence
polling, so obsolete work cannot keep the viewer awake.

The eighteenth rollback-only gate begins with one ready parent and four absent
children, then publishes the children one by one. Exact readiness rises
0→1→2→3→4, missing demand falls 4→3→2→1→0, and the coherent parent remains
visible until all four exact children can replace it together. The same gate
proves active polling, future retry timing, terminal idleness, and stale-failure
exclusion. All eighteen server-side gates pass.

#### Post-MVP Step 13: Viewer HTTP compatibility

- Expose the completed camera/demand pipeline through the viewer's existing
  `GET`/`POST /api/tiles` contract with `X-Terrain-Format: binary-v1`.
- Expose exact and ancestor texture reads through
  `/api/texture/<tile_id>.jpg` with the cache and provenance headers the
  existing texture streamer consumes.
- Keep MCP callables as the independently testable implementation surface; the
  HTTP layer performs request decoding and response adaptation only.

Implemented as a Terrain-owned sidecar rather than a modification to the
generic MCP host. The dynamic `server_start(host="127.0.0.1", port=5180)` and
`server_stop()` functions own an idempotent Uvicorn lifecycle through
`atlantis.server_shared`; MCP remains on port 8025. Exact textures preserve
their JPEG bytes and cache headers, ancestor textures are cropped with the
source service's south-first quadrant mapping and marked temporary, and true
misses return 202 after nonblocking texture submission.

The nineteenth offline gate validates viewer request parsing, binary response
headers, compact polling fields, exact texture/ETag behavior, ancestor crop
orientation, and missing-texture queueing. The twentieth opens a real temporary
listener and proves start, health, duplicate-start, stop, and duplicate-stop.
All twenty server-side gates pass. No browser is part of these gates.
