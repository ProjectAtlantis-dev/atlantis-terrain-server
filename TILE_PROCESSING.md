# Tile Processing from an Empty Database

This document describes how `/api/tiles` drives terrain demand when the
database starts with no tile payloads. The process is iterative: a single
request does not build every level from depth 0 through depth 16. Each browser
poll discovers completed work, exposes the next level of demand, and
reprioritizes unstarted work around the current camera.

## 0. Bootstrap the empty database

Before `/api/tiles` runs, the terrain backend initializes the database:

1. `open_db()` creates and migrates the schema.
2. The server detects that the `tiles` table has zero rows.
3. `seed_tiles()` creates quadtree skeletons from depth 0 through depth 8.
   Each row contains the tile address, bounds, parent link, `source='empty'`,
   and no heightmap or confidence map.
4. The bootstrap seed creates 87,381 skeleton rows.
5. `metadata.max_depth` is set to the actual target ceiling, depth 16.
6. Texture and classifier tables are initialized.
7. The in-process no-data cache starts empty.
8. Grundkort and GTK50 demand systems are enabled.

At this point, depths 0 through 8 exist as empty skeletons. Depths 9 through
16 do not exist yet and will be created lazily.

## 1. Receive the first `/api/tiles` request

The browser sends:

- camera position;
- height above ground level;
- terrain range;
- heading;
- known heightmap digests, initially empty; and
- the previously rendered depth cap, initially absent.

The server converts latitude and longitude to stereographic coordinates when
needed and settles the maximum LOD from the requested ceiling and camera
altitude.

## 2. Traverse the empty quadtree

`_query_tiles_stereo()` starts at `0-0-0`.

For an empty skeleton:

1. There is no measured geometric error, so traversal assumes an error equal
   to 10 percent of the tile width.
2. The radial LOD function determines how deeply the camera footprint wants
   to subdivide.
3. Traversal follows the pre-seeded hierarchy down to depth 8.
4. At depth 8, desired children do not exist.
5. Because the depth-8 tile has no real DEM, it cannot yet create depth-9
   children.
6. The visible depth-8 tile is placed in the `missing` list.

Missing candidates are deduplicated, sorted nearest to the camera first, and
capped at 100. On a completely cold first request, `tiles` will normally be
empty while `missing` contains visible depth-8 tiles.

## 3. Schedule first-request secondary demand

Because no heightmaps are available yet:

- normal visible-tile coastline scheduling has no targets;
- bathymetry has no eligible tiles;
- no texture metadata exists; and
- the browser cannot request terrain textures because it has no rendered
  terrain tiles.

The endpoint still triggers viewer-wide acquisition:

1. Grundkort checks whether the camera is near a known settlement and queues
   its archive if necessary.
2. GTK50 prefetch requests missing coastline blocks intersecting the 25 km
   camera neighborhood.

## 4. Record and dispatch DEM demand

For each selected missing depth-8 tile:

1. The server writes `dem_demanded_at`.
2. `_schedule_cog_demand()` replaces its unstarted queue with the newest
   nearest-first list.
3. Free DEM workers take tiles from the list.
4. A worker writes `dem_requested_at`.
5. The tile is added to the active download set.

Work already running is allowed to finish after the camera moves. Unstarted
work is replaced and reprioritized by each later `/api/tiles` request.

## 5. Perform coastline preflight in each DEM worker

Before downloading elevation, the worker asks for the authoritative coastline
mask.

### All-ocean tile

If the tile is authoritatively all ocean, the worker:

1. marks it `official_ocean`;
2. stores the authoritative ocean terrain result; and
3. avoids unnecessary DEM provider requests.

### Land or mixed tile with coastline data

The worker proceeds to elevation acquisition with the authoritative mask
available.

### Missing GTK50 data

The coastline path can request the required GTK50 block asynchronously. The
current DEM attempt may continue without definitive coastline classification;
later polling and mask rebuilding correct derived state after the source data
arrives.

## 6. Fetch real elevation through depth 12

For tiles at depths 8 through 12, the worker runs the provider acquisition
chain:

1. It attempts the configured COG sources.
2. It records each concrete provider attempt in `cog_requested_at` and the
   audit log.
3. If real data arrives, it:
   - normalizes missing samples;
   - creates a confidence map;
   - stores the terrain product through `write_tile()`; and
   - records the actual source.
4. If a provider has no child data, it tries to resample from an available
   parent.
5. If neither provider nor parent can supply the tile, it marks the tile
   `no_data` and adds it to the process no-data cache.
6. Operational failures remain retryable with exponential backoff.

A parent-resampled result is temporary. It can render immediately but becomes
eligible for another provider attempt after a cooldown.

## 7. Return the first response

The first cold response reports approximately:

```text
tiles: []
missing: [visible depth-8 addresses...]
downloading: [active worker tile IDs...]
demActionable: true
```

It also includes queue and status fields for coastline, bathymetry, textures,
and Grundkort. The browser sees active DEM work and schedules another
`/api/tiles` poll.

## 8. Discover completed depth-8 tiles on later polls

Once some depth-8 DEMs exist, traversal changes:

1. A populated depth-8 tile becomes a valid visible fallback.
2. If camera LOD wants depth 9 and no children exist, `_ensure_children()`
   creates all four depth-9 skeletons.
3. The response includes the real depth-8 parent so terrain renders
   immediately.
4. Its depth-9 children enter the missing-demand list.
5. Those children are sorted against all other missing work.
6. The nearest 100 are dispatched.

This establishes the recurring acquisition ladder:

```text
D8 becomes real
  -> create D9 skeleton quad
  -> return D8 fallback
  -> acquire D9

D9 becomes real
  -> create D10 skeleton quad
  -> return D9/D8 fallback
  -> acquire D10

D10 -> D11 -> D12
```

If only some children are ready, the real parent remains in the response while
missing siblings continue downloading.

## 9. Build coastline masks behind visible DEMs

Once `/api/tiles` returns tiles with heightmaps, it derives coastline targets
from them:

1. A tile at depth 12 or shallower is its own target.
2. A tile deeper than 12 maps to its depth-12 ancestor.
3. Already-cached masks are removed.
4. Remaining targets are sorted nearest-first.
5. A single background coastline worker rasterizes and stores them.
6. Each new `/api/tiles` poll replaces unstarted mask work with the current
   visible footprint.

This work intentionally happens outside the interactive request path.

## 10. Start texture demand from the browser

`/api/tiles` does not download imagery itself. It annotates each returned
terrain tile with exact texture availability, ancestor fallback availability,
fetch state, and texture source.

After reconciling geometry, the browser requests:

```text
/api/texture/<tile-id>.jpg
```

With an empty texture cache:

1. The texture endpoint queues a background worker.
2. It looks for a cached ancestor.
3. If no ancestor exists, it returns HTTP 202 with status `fetching`.
4. The browser retries with bounded backoff.
5. The worker fetches an aligned provider metatile.
6. It splits that metatile into sibling textures.
7. It stores all resulting children together.
8. Later requests receive the cached JPEG.

If a parent texture exists, the endpoint can immediately return an ancestor
crop while exact imagery is being acquired.

## 11. Cook DEMs past the provider contract

Depth 12 is the real DEM provider contract boundary. When traversal wants
depth 13:

1. A real depth-12 parent causes depth-13 skeletons to be created.
2. Those children appear in `missing`.
3. The normal DEM scheduler dispatches them.
4. The worker detects `depth > 12` and does not call a COG provider.
5. `_cook_cooked_dem_quad()` requires a stable parent DEM.
6. It upscales one parent surface and splits it into all four children.
7. It writes the sibling quad as `cooked_dem`.

The process repeats for depths 14 through 16:

```text
stable D12
  -> cook D13 quad
  -> cook D14 quad
  -> cook D15 quad
  -> cook D16 quad
```

Each level is exposed by a later `/api/tiles` poll. One worker invocation does
not recursively generate the entire descendant chain.

## 12. Build deep textures through the corresponding ladder

Texture processing follows a similar progression:

1. Provider metatiles are fetched while the source is expected to contain
   genuine detail.
2. At finer levels, returned imagery is inspected for provider blowup.
3. Imagery that is merely an upscaled parent is rejected as genuine detail.
4. The texture cooker requires a stable parent texture.
5. It upscales and writes all four children as `cooked_upscale`.
6. Beyond the known provider-detail ceiling, the provider probe is skipped
   and cooking happens directly.
7. If a parent is missing, the parent is queued first and the child is retried
   later.

Deep classifier data is not recomputed at every cooked level. Deep tiles
inherit classification from the nearest real ancestor.

## 13. Schedule bathymetry after its prerequisites exist

Every `/api/tiles` response passes its visible populated tile IDs to the
bathymetry scheduler. A job requires:

1. visible depth-12 DEM ancestry;
2. an authoritative depth-12 coastline mask;
3. a mixed land/water tile, or an all-water tile within 2 km of a mixed
   coastline tile; and
4. no existing bathymetry result for the corresponding depth-8 job.

Eligible demand is coalesced to depth 8 and sent to the Glacier worker. Open
ocean does not independently create bathymetry. Bathymetry remains separate
from the canonical terrain DEM and is composed at read or render time.

## 14. Poll until the visible footprint converges

The browser continues polling while the response reports any of:

- actionable missing DEMs;
- active DEM downloads;
- retryable synthetic DEMs;
- coastline work;
- server texture work; or
- a future DEM retry time.

Each poll:

1. reruns LOD for the current camera;
2. discovers completed products;
3. creates the next required child skeletons;
4. returns the best available fallback coverage;
5. replaces stale unstarted work with current camera demand; and
6. advances terrain, coastline, texture, and bathymetry by one or more steps.

Eventually the visible footprint has:

- requested real DEM detail through depth 12;
- cooked DEM detail through the altitude-selected ceiling, potentially depth
  16;
- coastline masks at the depth-12 contract;
- real or cooked textures;
- eligible bathymetry; and
- nearby GTK50 and Grundkort source data.

At that point `/api/tiles` becomes mostly a read and reconciliation call until
the camera moves, altitude changes, a retry becomes due, or cached data is
invalidated.
