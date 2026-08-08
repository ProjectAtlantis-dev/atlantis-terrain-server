# Flask Terrain Server Migration

## Purpose

This document defines how to migrate the terrain backend out of
`flaskserver` into a replacement system. It is intentionally independent of
the destination language, framework, and storage engine.

The migration is ordered by dependency. It does not treat `terrain.db` as one
indivisible source of truth: the current database contains source observations,
reproducible derivatives, control state, and runtime caches in the same tables.
Those classes must be separated before behavior is moved.

The companion [data provenance audit](DATA_PROVENANCE_AUDIT.md) is the
authoritative inventory of the current tables and purge boundaries. When a new
producer or `source` label is introduced, update that audit and classify it
before migrating or purging data.

The ordered implementation checklist is
[`migration_steps.md`](migration_steps.md). That checklist governs execution:
existing terrain/acquisition logic is extracted and shared, with refactoring
and glue allowed but no algorithm reimplementation during migration.

## Goals

- Preserve every human decision, operator setting, user-authored object, and
  provider request identity that cannot be reconstructed from code.
- Reacquire provider data with the replacement acquisition code; do not seed
  the replacement from downloaded payloads cached by Flask.
- Make every derived artifact reproducible from freshly acquired source
  artifacts and versioned code.
- Reproduce the current tile-address, heightmap, LOD, seam, and response
  contracts before changing their behavior.
- Allow Flask and the replacement to run side by side during verification.
- Switch reads before switching acquisition and writes.
- Demonstrate a complete cold acquisition and rebuild before retiring Flask.

## Non-goals

- Redesigning the terrain coordinate system during migration.
- Changing the visual output, LOD policy, or provider precedence while proving
  parity.
- Migrating downloaded DEM, imagery, WMS, vector archive, or evidence payloads
  out of the Flask caches.
- Copying all legacy derived rows into the new system merely because they are
  present in SQLite.
- Running two independent authoritative writers against the same logical
  artifact.

## Provenance model

Every persistent field or artifact belongs to one of four classes.

### Source

A source artifact is an external observation, downloaded provider response,
human decision, user-authored state, or provenance fact that cannot be
recreated solely from retained local inputs and code.

This classification says how an artifact is derived; it does not say that a
legacy copy must be migrated. Provider artifacts are source artifacts after
the replacement downloads them itself. Legacy provider bytes are an oracle for
comparison only and must not be used to bootstrap the destination.

Examples:

- ArcticDEM and Copernicus heightmap payloads.
- Sentinel-2 and Dataforsyningen imagery.
- Provider `no_data` and no-coverage results.
- GTK50 GeoPackages and downloaded WMS hydrography.
- Sounding evidence and source-asset hashes.
- Human classifier annotations.
- Grundkort source geometry and original source properties.
- User `enabled` decisions and saved vehicle state.

Downloaded data remains source by provenance, but legacy downloaded bytes are
not migration inputs. The replacement must fetch them again. Because a
provider may return different bytes later, verification records both revisions
and compares the decoded contract and downstream behavior.

### Derived

A derived artifact is reproducible from retained source artifacts, declared
configuration, and a versioned recipe.

Examples:

- Parent-resampled and cooked heightmaps.
- Rasterized coastline and effective-water masks.
- Bathymetry solutions and sounding/model comparisons.
- Texture crops, cooked upscales, road bakes, and cliff grafts.
- Classifier tiles, votes, predictions, and verification renders.
- Terrain seam caches.
- Terrain-sampled building ground elevations and roof colors.

Derived artifacts may be discarded. The replacement must be able to rebuild
them without reading a legacy derived artifact.

### Control

Control data describes schemas, addresses, recipes, jobs, or operator choices
rather than terrain observations.

Examples:

- Tile scaffold, parent relationships, and bounding boxes.
- Schema and recipe versions.
- Demand, retry, and queue state.
- The bathymetry pause setting.
- Pointers to the current artifact revision.

### Runtime

Runtime values are request-specific and normally should not be persisted as
authoritative data.

Examples:

- The variable-depth LOD leaf set for a camera request.
- Ancestor fallback selection.
- Client residency comparisons.
- In-flight job and connection state.
- A response package assembled for one request.

## Required destination boundaries

The replacement should expose three storage concepts even if they use one
physical database initially.

### Source store

The source store is durable and protected from accidental replacement. Human,
operator, and user-authored state is backed up. Reacquirable provider payloads
may be cached and backed up operationally, but neither a legacy copy nor a
backup may be required for the migration proof. A source artifact should have:

- Stable artifact kind and identity.
- Spatial identity, normally a tile ID or source feature ID.
- Provider or author identity.
- Acquisition or edit timestamp.
- Content hash where bytes are retained.
- Source request, dataset, URL, or archive identity where applicable.
- Payload or a durable reference to the payload.

### Derived artifact store

The derived store is a rebuildable cache. A derived artifact should have:

- Artifact kind and spatial identity.
- Recipe name and version.
- Ordered input artifact identities and hashes.
- Output hash.
- Creation timestamp.
- Current/stale state, or enough information to determine it.

An artifact is valid only when its recipe version and all input hashes still
match.

### Control store

The control store holds schema versions, deterministic configuration,
operator state, and job coordination. It must not be used as a substitute for
source provenance.

## Dependency graph

```text
Coordinate and tile contract
            |
            v
       Source artifacts <--------- Source acquisition
            |
            v
   Base heightmap derivation
            |
            +-----------------------------+
            |                             |
            v                             v
  Coastline/water derivation       Texture derivation
            |
            v
   Bathymetry derivation
            |
            v
 Effective render heightmaps
            |
            +----------+------------------+
            |          |                  |
            v          v                  v
    Classification  Asset enrichment   LOD selection
                                              |
                                              v
                                         Seam repair
                                              |
                                              v
                                      Response assembly
                                              |
                                              v
                                  Operations and client delivery
```

Source acquisition is both an early logical dependency and an early migration
gate. Each provider domain must be downloaded by the replacement before its
derived builders or loaders are promoted. Flask's cached payloads may be read
to compare behavior, but never inserted into the destination.

## Current system inventory

### Coordinate and tile system

The canonical terrain address is `depth-col-row` within the EPSG:3413 root
square declared in `flaskserver/terrain_config.py`. Heightmap tiles use a
65 by 65 sample grid. The runtime supports depth 16, while depth 12 is the
measured provider contract for the deep-terrain pipeline.

This system is deterministic control logic. Generate it in the replacement;
do not migrate the SQLite scaffold as observational truth.

### Heightmaps

The `tiles` table is mixed:

- Address, depth, row, column, bounds, and parent are deterministic control.
- `arcticdem*`, `copernicus`, and their `unmasked_*` payloads are source.
- `no_data` is a durable source-side negative result.
- `parent_resampled`, `cooked_dem`, `official_coastline`, retired fractal
  outputs, and clobbered variants are derived.
- DEM/COG demand timestamps are control state.

The source heightmap contract consists of a 65 by 65 float32 elevation grid,
a confidence grid, source provenance, and spatial identity. Geometric error is
derived from the heightmap.

### LOD and seams

LOD is a runtime computation over the tile hierarchy and artifact-availability
index. It uses camera position, range, AGL, hysteresis, and configured depth
limits to select a variable-depth leaf set. Missing leaves may use an ancestor
and generate demand for a better artifact.

Mixed-LOD seam repair depends on the selected neighboring leaves, so it occurs
after LOD selection. `terrain_seam_cache` is derived and disposable.

### Coastline and water

- `gtk50_blocks/*.gpkg` files are retained source vectors.
- `hydrography_masks` are downloaded source responses.
- `coastline_masks` are derived rasterizations.
- Connected-water masks, the synthetic water floor, and effective rendered
  water geometry are derived.

Water processing must not mutate a measured source DEM. It produces effective
render geometry downstream of the canonical land heightmap.

### Textures

Provider images stored as Sentinel-2 or Dataforsyningen generations are
source. Ancestor crops, rate-limit crops, and cooked upscales are derived.

`ancestor_crop_nodata` and `ocean_nodata` currently combine a provider
no-coverage fact with derived fallback pixels. The replacement should split
these into a durable coverage result and a separately rebuildable fallback
texture.

### Bathymetry

Sounding observations, evidence status, URLs, notes, and source hashes are
source. Stereo coordinates are deterministic. Model comparison fields and
the `bathymetry` raster table are derived.

Bathymetry remains separate from `tiles.heightmap`. At render time it may
replace the synthetic water floor where valid water-constrained depths exist;
it must never replace canonical land elevations.

### Classification

Human annotations are source labels even though they are bound to a
segmenter version and segment ID. Classifier tiles, vote maps, confidence,
predictions, training results, and galleries are derived.

### Buildings, roads, and user assets

Grundkort archives, imported feature identity, surveyed geometry, original
properties, and user `enabled` choices are source. Projected/normalized
coordinates are deterministic derivatives retained alongside the import.
Terrain-sampled building ground heights and roof colors are derived and must
be invalidated when their terrain inputs change.

Saved vehicles and other user-authored assets are source state.

## Concrete action plan

Execute these work packages in order. Check a step only when its named file,
command, test, or gate report exists. The `runMigration` commands below are a
required interface to implement in Work Package 1; they are not assumed to
exist today.

### Work Package 1: Create the migration workspace and command runner

1. [ ] Create `migration/decisions.md`. Record the destination language,
   service directory, source/derived/control stores, queue, object storage,
   local-development topology, and deployment owner. Do not start adapter work
   while any of those fields says “unknown.”
2. [ ] Create these tracked directories:
   `migration/manifests/`, `migration/fixtures/`, `migration/reports/`,
   `migration/gates/`, and `migration/schema/`.
3. [ ] Add a root `runMigration` executable with these subcommands:
   `inventory`, `capture`, `acquire`, `import-state`, `compare`, `rebuild`,
   `gate`, and `cold-start`.
4. [ ] Make every subcommand accept `--run-id` and write structured JSON under
   `migration/reports/<run-id>/`. Refuse to overwrite an existing run ID.
5. [ ] Add `runMigration --help` and one smoke test to CI.
6. [ ] Write `migration/schema/run-report.schema.json` defining provider
   requests/results, state imports, artifact hashes, comparisons, timings,
   errors, and authority changes.
7. [ ] Run `./runMigration inventory --run-id bootstrap --check`. The command
   may report missing ownership at this stage, but it must execute and produce
   valid JSON.

Stop/go: do not proceed until the destination decisions are recorded, the CLI
runs locally and in CI, and report output validates against its schema.

### Work Package 2: Inventory every Flask read and assign ownership

1. [ ] Generate `migration/query_owners.yaml` by scanning production Python for
   `SELECT`, `JOIN`, `read_tile`, `read_texture`, `_get_db()`, and
   `_get_assets_db()` usage. Exclude tests explicitly; do not silently skip
   dynamically constructed SQL.
2. [ ] For every read, record: file/line, endpoint or worker, tables/columns,
   side effects triggered after the read, owning slice, comparator, and planned
   adapter method.
3. [ ] At minimum, assign existing reads for `database.read_tile`,
   `database.read_tile_metadata`, `database.get_metadata`,
   `serve.load_no_data_cache`, `serve.query_tiles_stereo`, all three texture
   lookup functions, coastline/effective-heightmap reads, bathymetry-map reads,
   classifier storage, building/road/asset reads, and vehicle reads.
4. [ ] Add an allowlist entry for each intentionally retained direct query.
   Every allowlist entry needs an owner and removal increment.
5. [ ] Make `./runMigration inventory --check` fail when a production read is
   unowned or a recorded file/line no longer exists.
6. [ ] Commit the generated inventory and its CI test before changing a loader.

Stop/go: zero unowned production reads.

### Work Package 3: Add per-domain read adapters and shadow mode

1. [ ] Define interfaces for `tile_control`, `base_dem`, `texture`, `water`,
   `bathymetry`, `classifier`, and `assets` in the destination-neutral boundary
   selected in `migration/decisions.md`.
2. [ ] Implement a legacy adapter for each interface by delegating to current
   Flask behavior. Preserve return shapes; do not duplicate terrain logic in
   the adapter.
3. [ ] Add these independently configurable modes:
   `TILE_CONTROL_READ_MODE`, `BASE_DEM_READ_MODE`, `TEXTURE_READ_MODE`,
   `WATER_READ_MODE`, `BATHYMETRY_READ_MODE`, `CLASSIFIER_READ_MODE`, and
   `ASSET_READ_MODE`. Accept only `legacy`, `shadow`, or `destination`; fail
   startup on any other value.
4. [ ] Implement the comparing adapter. It must normalize results, run legacy
   and destination reads, write a mismatch record, and return the legacy result
   while in `shadow`.
5. [ ] Add a request-scoped `side_effects=False` path. Shadow reads must not
   enqueue DEM/texture/coastline/bathymetry/Grundkort work or write seams,
   caches, demand timestamps, logs-as-state, or user state.
6. [ ] Route one boundary first: `database.read_tile_metadata` and allowlisted
   metadata reads. Add unit tests for all three modes, destination failure,
   mismatch reporting, and rollback to legacy.
7. [ ] Route remaining reads behind their interfaces incrementally, updating
   `migration/query_owners.yaml` after each change.

Stop/go: the metadata loader can switch `legacy → shadow → destination →
legacy` in one test, and the shadow test proves zero writes.

### Work Package 4: Build fixture, acquisition-manifest, and gate tooling

1. [ ] Define `migration/schema/acquisition-manifest.schema.json` with provider,
   request identity, spatial identity, dataset/version selector, expected
   result class, timeout/retry policy, and comparator.
2. [ ] Define `migration/schema/fixture-manifest.schema.json` with immutable
   inputs, Flask revision, expected output, comparator, tolerance, and hashes.
3. [ ] Implement `runMigration capture` so fixture output is written under
   `migration/fixtures/<slice>/<case>/` and never refreshed without
   `--replace --reason`.
4. [ ] Implement `runMigration compare` so every mismatch includes slice, case
   or request ID, legacy/destination digests, normalized diff, timing, and
   comparator version.
5. [ ] Implement `runMigration gate` so it reads reports rather than accepting
   manually typed counts. It must refuse promotion with failed acquisition,
   invalid schema, unexplained mismatch, unowned read, or missing rollback
   result.
6. [ ] Create `migration/gates/template.md` with scope, evidence links,
   authority before/after, rollback command, reviewer, decision, and timestamp.
7. [ ] Prove the tooling with one deliberately matching and one deliberately
   mismatching synthetic loader case.

Stop/go: CI detects the deliberate mismatch, the matching case produces a
valid gate candidate, and no production provider is contacted yet.

### Work Package 5: Generate tile control and promote its loader

1. [ ] Add a tile-control manifest covering valid IDs, root, all four child
   quadrants, maximum supported depth, invalid syntax, negative components, and
   out-of-range addresses.
2. [ ] Generate the destination scaffold from `terrain_config.py` semantics;
   do not copy `tiles` rows.
3. [ ] Import only the reviewed `metadata` keys `bbox`, `grid_resolution`, and
   `max_depth`. Put the exact allowlist in
   `migration/manifests/control-state.yaml` and reject all other keys.
4. [ ] Run exact comparisons for tile IDs, depth/column/row, bounds, parent,
   children, and depth counts.
5. [ ] Run `./runMigration compare --slice tile-control --run-id <id>` in
   shadow mode.
6. [ ] Test rollback, then write and approve
   `migration/gates/01-tile-control.md`.
7. [ ] Set only `TILE_CONTROL_READ_MODE=destination` in the migration
   environment.

Stop/go: zero exact mismatches and no payload-bearing legacy field in the
destination.

### Work Package 6: Reacquire DEMs and promote DEM acquisition/reads

1. [ ] Create `migration/manifests/dem.json`. Seed it with known current cases
   `10-334-192` (ArcticDEM), `1-0-1` (Copernicus), and `1-1-0` (no-data), then
   add a provider-overlap tile, a corrupt-response fixture, a timeout fixture,
   and a valid-payload clobber attempt. Review the spatial cases before using
   them as permanent fixtures.
2. [ ] Implement destination ArcticDEM and Copernicus request, retry, decode,
   provider-precedence, no-data, provenance, and persistence paths.
3. [ ] Delete the destination DEM slice and run
   `./runMigration acquire --provider dem --manifest migration/manifests/dem.json
   --require-empty --run-id <id>`.
4. [ ] Assert that no destination payload hash appears because it was imported
   from `terrain.db`; all must have a destination acquisition event.
5. [ ] Compare decoded 65-by-65 arrays, NaN masks, extrema, confidence behavior,
   geometric error, source family, fallback, and negative-result behavior.
6. [ ] Run base DEM loaders in shadow for the manifest tiles and sampled live
   requests. Resolve every semantic mismatch; upstream byte changes must have a
   reviewed difference record.
7. [ ] Delete and reacquire the slice a second time to prove cold repeatability.
8. [ ] Stop Flask DEM/COG acquisition, verify it is drained, switch destination
   DEM acquisition plus `BASE_DEM_READ_MODE` together, and run smoke requests.
9. [ ] Execute rollback once, restore destination authority, and approve
   `migration/gates/02-dem.md`.

Stop/go: fresh acquisition works from an empty store, failure cases do not
clobber valid data, shadow has no unexplained semantic mismatch, and rollback
has been exercised.

### Work Package 7: Rebuild core terrain and promote bounded `/api/tiles`

1. [ ] Port parent aggregation, child resampling, deep cook, confidence edge
   reconciliation, geometric error, LOD selection, and seam repair.
2. [ ] Create destination seam storage empty; add a test that fails if a legacy
   `parent_resampled`, `cooked_dem`, `official_coastline`, or seam payload is
   read.
3. [ ] Capture fixed camera cases with range, AGL, previous depth cap, origin,
   known residency digests, missing tiles, equal-depth neighbors, and mixed-LOD
   neighbors.
4. [ ] Run artifact comparisons for rebuilt arrays and edges, then endpoint
   comparisons for JSON and binary `/api/tiles` with unrelated acquisition and
   composition disabled.
5. [ ] Change one reacquired DEM revision and assert the exact dependent
   parents, children, geometric errors, and seams become stale and rebuild.
6. [ ] Enable destination terrain reads only for a declared non-water test
   region; monitor errors, p50/p95, missing demand, and response sizes.
7. [ ] Exercise region rollback and approve
   `migration/gates/03-core-terrain.md`.

Stop/go: fixed-camera leaf sets and binary framing match, invalidation works,
and the bounded region completes its soak.

### Work Package 8: Reacquire imagery and promote texture acquisition/reads

1. [ ] Create `migration/manifests/imagery.json` with Dataforsyningen provider,
   metatile split/harmonization, Sentinel fallback, rate-limit, no-coverage,
   ancestor fallback, and ocean cases. Seed known comparison IDs
   `10-328-212`, `10-327-212`, `10-326-206`, and `11-706-362`.
2. [ ] Implement destination provider fetching and separate records for
   coverage observation, provider payload, generated fallback, input revision,
   and recipe version.
3. [ ] Start with no destination texture rows and run the imagery acquisition
   manifest. Never import a `textures.texture` blob.
4. [ ] Compare provider outcome, decoded image dimensions, crop geometry,
   metatile quadrants, harmonization, blowup decision, and perceptual metrics.
5. [ ] Change one provider revision and assert all descendant crops/cooks and
   texture-dependent classifiers become stale.
6. [ ] Shadow `read_texture`, `texture_ids_in`, `texture_sources_in`, the JPEG
   endpoint, and `/api/tiles` texture flags.
7. [ ] Stop Flask imagery workers, promote destination imagery acquisition and
   `TEXTURE_READ_MODE`, exercise rollback, and approve
   `migration/gates/04-imagery.md`.

### Work Package 9: Reacquire water data and promote water composition

1. [ ] Create `migration/manifests/water.json` with land, coast, lake, fjord,
   all-ocean, WMS-no-coverage, and GTK50-package cases. Include known database
   cases `1-0-1` for hydrography and `10-324-212` for a coastline comparison,
   then review/add representative local cases.
2. [ ] Delete destination WMS/GTK caches and download them through destination
   acquisition code. Never copy `hydrography_masks` or `gtk50_blocks`.
3. [ ] Rasterize coastline masks from the newly downloaded GeoPackages; never
   copy `coastline_masks`.
4. [ ] Compare provider outcomes, dimensions, vector geometry, raster masks,
   connectivity, water floor, and effective heightmaps.
5. [ ] Assert measured DEM bytes remain unchanged by water composition.
6. [ ] Shadow water readers and `/api/tiles?bathymetry=0` across the manifest.
7. [ ] Stop Flask WMS/GTK50 workers, promote destination water acquisition and
   `WATER_READ_MODE`, exercise rollback, and approve
   `migration/gates/05-water.md`.

### Work Package 10: Reacquire evidence and promote bathymetry

1. [ ] Create `migration/manifests/evidence.json` from documented provider
   locators. Start with the PANGAEA sources already identified by `source_url`,
   including DOI `10.1594/PANGAEA.119160`, and add one source for every parser
   format.
2. [ ] Export only curator state to
   `migration/reports/<run-id>/sounding-curation.json`: stable source identity,
   `evidence_status`, curator-authored note, and explicit overrides. Export no
   observed coordinates/depths or source payload bytes.
3. [ ] Starting empty, download and parse evidence; recompute projected
   coordinates and apply curator state by stable identity. Fail on orphaned or
   ambiguous curation.
4. [ ] Rebuild bathymetry and model comparisons without copying `bathymetry` or
   `soundings.model_*` values.
5. [ ] Compare evidence semantics, water-constrained grids, health results, the
   bathymetry-map endpoint, and `/api/tiles` with bathymetry enabled.
6. [ ] Purge destination bathymetry and rebuild it again.
7. [ ] Stop Flask evidence/bathymetry workers, promote destination acquisition,
   `BATHYMETRY_READ_MODE`, and composition; exercise rollback and approve
   `migration/gates/06-bathymetry.md`.

### Work Package 11: Migrate annotations and rebuild classifiers

1. [ ] Export exactly the human annotation identity, class, segmenter version,
   segment ID, and timestamp; hash and count the export.
2. [ ] Import annotations idempotently. Run a second import and assert zero
   changes.
3. [ ] Create classifier output/vote stores empty and rebuild them from
   reacquired terrain, imagery, water, and imported annotations.
4. [ ] Compare class maps, confidence maps, votes, channels, and relevant
   classifier routes with declared comparators.
5. [ ] Delete all destination classifier derivatives and prove annotations are
   unchanged after rebuild.
6. [ ] Quiesce the Flask annotation writer, replay the final mutation set,
   promote destination classifier reads/writes, prove read-after-write,
   exercise rollback, and approve `migration/gates/07-classifier.md`.

### Work Package 12: Reacquire Grundkort and migrate user decisions/assets

1. [ ] Create `migration/manifests/grundkort.json` with every required initial
   settlement plus one missing-package and retry case.
2. [ ] Export only imported-feature `enabled` decisions keyed by stable feature
   ID and user-authored vehicle rows/state. Do not export Grundkort geometry,
   source properties, spatial indexes, or terrain-derived ground values.
3. [ ] Starting without archives or feature rows, download and ingest Grundkort
   through destination code. Rebuild projected rings/paths and indexes.
4. [ ] Apply enabled decisions; fail with a review report for missing or
   ambiguous reacquired feature IDs.
5. [ ] Resample building ground data from promoted terrain.
6. [ ] Shadow building, road, asset, and vehicle loaders plus their four API
   endpoints. Compare counts by type/settlement and binary building output.
7. [ ] Quiesce Flask decision/vehicle writers, replay final mutations, promote
   destination Grundkort acquisition and asset reads/writes, prove read-after-
   write, exercise rollback, and approve `migration/gates/08-assets.md`.

### Work Package 13: Rebuild disposable caches and migrate operations

1. [ ] Create road-bake, cliff-graft, seam, classifier, coastline, and
   bathymetry cache stores empty. Do not create `water_purge_audit` or retired
   `terrain_artifact_*` storage without a documented consumer.
2. [ ] Trigger each cache producer from promoted upstream inputs and verify its
   recorded recipe/input revisions.
3. [ ] Change one upstream input per cache and assert invalidation and rebuild.
4. [ ] For tile-package, pipeline, coverage, health, client-log, GPU-profile,
   and WebSocket behavior, record an explicit `keep`, `replace`, or `retire`
   decision in `migration/decisions.md`.
5. [ ] Implement and test every kept/replaced operational path.
6. [ ] Add readiness checks for process, source store, derived store, recipe
   availability, and each required provider.
7. [ ] Approve `migration/gates/09-operations.md`.

### Work Package 14: Run the cold-start acceptance test

1. [ ] Provision an isolated environment with empty databases, object stores,
   caches, and queues and with no mount/path to Flask payload storage.
2. [ ] Run `./runMigration cold-start --manifest-dir migration/manifests
   --require-empty --run-id <id>`.
3. [ ] Import only allowlisted control state, annotations, curation, enabled
   decisions, and user-authored assets.
4. [ ] Acquire DEM, imagery, water, sounding evidence, and Grundkort through
   destination network paths for the complete declared initial operating
   region.
5. [ ] Rebuild every required derivative and run contract, artifact, endpoint,
   and current-client regression suites.
6. [ ] Verify the report contains zero legacy payload imports and no
   undocumented manual step.
7. [ ] Record acquisition time, rebuild time, provider request/failure/retry
   counts, coverage, artifact counts, and p50/p95 endpoint latency.
8. [ ] Approve `migration/gates/10-cold-start.md` only after repeating the test
   successfully from a second empty environment.

### Work Package 15: Cut over and retire Flask

1. [ ] Confirm gates 01 through 10 are approved and every production read in
   `migration/query_owners.yaml` is destination-owned or explicitly retired.
2. [ ] Confirm each provider and mutable-state domain has exactly one active
   authoritative writer.
3. [ ] Put Flask in read-only oracle mode and run the agreed compatibility soak.
4. [ ] Run the current web client against destination-only endpoints and
   complete the flight/regression checklist.
5. [ ] Back up human/operator/user state and restore it into a clean destination
   environment. Reacquire provider data; do not restore legacy provider caches.
6. [ ] Rehearse rollback for mutable state and document the point after which
   rollback means restoring destination state rather than re-enabling Flask.
7. [ ] Remove Flask from traffic, retain its read-only comparison data for the
   agreed period, and approve `migration/gates/11-retirement.md`.

## Incremental migration runbook

The migration unit is a **loader slice**, not a database. A loader slice is the
smallest set of records that one named read path needs in order to return a
complete result. Move one slice, run the legacy and destination loaders against
the same requests, promote that loader only after they agree, and then start the
next slice.

This is especially important for `tiles`, `textures`, `soundings`, `metadata`,
and `assets`: each contains source, derived, and control fields. No step below
copies one of those tables wholesale.

### Controls required before the first acquisition or state copy

Implement these controls once and use them for every slice:

- A per-loader read mode with the values `legacy`, `shadow`, and `destination`.
  In `shadow`, serve the legacy result and compare it with the destination
  result. Do not make one global database switch.
- A repeatable acquisition runner for provider data. Every run records the
  provider, request manifest, dataset/version selectors, response status,
  negative result, content hash, acquisition time, destination schema version,
  and code revision. The runner must support an empty destination store.
- A snapshot extractor and idempotent importer only for non-downloadable human,
  operator, and user-authored state. Every such run records a stable run ID,
  source snapshot identity, row/column predicate, schema version, and
  start/end watermark.
- A migration ledger recording acquired, extracted, imported, rejected, and
  compared counts; request and payload hashes; loader comparison counts;
  mismatches; replication lag for mutable state; promotion time; and rollback
  time.
- A mismatch report that identifies the loader, request or artifact identity,
  legacy digest, destination digest, and comparator. Aggregate counts without
  individual identities are not sufficient to approve a slice.
- A feature flag for each loader named below. Switching a flag back to
  `legacy` is the read rollback and must not require a reverse data migration.

For provider domains, the destination acquisition code writes only to an
isolated destination namespace during shadowing. When that domain is promoted,
stop its Flask acquisition worker and make the destination acquirer and loader
authoritative together. The legacy cache remains read-only for rollback and
comparison; it is never replayed into the destination.

Flask remains the sole writer for human/operator/user state while its readers
are moved. Replay changes after the snapshot using a durable watermark and
keep replaying them while the destination reader is active. Do not use
application dual writes: a partial dual-write failure makes authority
ambiguous.

An `updated_at` column is not by itself a safe change stream: timestamps may
collide, deletes are invisible, and some tables have no such column. Use a
transactional change log/CDC source where available. Otherwise briefly quiesce
the one affected mutable-state writer, recopy identities changed since the snapshot,
reconcile deletes, and promote before resuming it. Record which mechanism each
slice uses in its gate record.

Every slice follows the same seven operations:

1. Freeze the slice schema, request or row predicate, field mapping, and
   comparator.
2. Capture fixtures plus either a provider request manifest or a mutable-state
   watermark.
3. Starting with an empty slice, reacquire provider data through destination
   code, or copy only the explicitly listed irreplaceable state.
4. Reconcile identities, nulls, coverage/negative results, payload contracts,
   hashes where stable, and provenance. A provider may legitimately return new
   bytes; such differences require review, not a legacy-byte import.
5. Run the named loader in `shadow` and resolve every mismatch.
6. Promote that domain's destination loader and, for provider data, its
   acquisition writer; observe it for the declared soak period.
7. Record the gate result. On failure, stop destination acquisition, set the
   loader back to `legacy`, and repeat the gate from an empty destination slice.

### Gate record

Each slice must add a signed or reviewed gate record containing:

| Field | Required value |
| --- | --- |
| Scope | Exact provider requests or state tables, predicates, columns, and metadata keys |
| Source | Acquisition manifest or snapshot ID and last replayed watermark |
| Reconciliation | Acquired/imported/rejected counts, coverage, and payload-hash evidence |
| Loader evidence | Requests compared, matches, mismatches, and report location |
| Performance | Destination p50/p95 and error rate versus Flask |
| Authority | Current reader and sole writer for the slice |
| Decision | Promoted, rolled back, or blocked; reviewer and timestamp |

A later slice may depend only on an earlier slice with a recorded `promoted`
decision. “The import completed” is not a promotion criterion.

### Slice order at a glance

| Increment | Acquire or migrate | Rebuild instead of copy | Loader/writer promotion |
| --- | --- | --- | --- |
| 1 | Allowlisted `metadata` keys | Tile address scaffold | Tile control and metadata |
| 2 | Download DEMs and reproduce no-data observations | Nothing yet | DEM acquisition, base DEM, and no-data |
| 3 | Nothing | Parent/cooked DEMs and seams | Core terrain and bounded `/api/tiles` |
| 4 | Download provider imagery and reproduce no-coverage | Texture crops and cooks | Imagery acquisition and texture loaders |
| 5 | Download hydrography and GTK50 | `coastline_masks` and water composition | Water acquisition and effective terrain |
| 6 | Download sounding evidence; migrate only curation | `bathymetry` and model comparisons | Evidence acquisition and bathymetry loaders |
| 7 | Migrate `classifier_annotations` | `classifier_tiles` and `classifier_votes` | Classifier loaders and annotation writer |
| 8 | Download Grundkort; migrate decisions and user assets | Terrain-dependent enrichment | Asset loaders and mutable-state writers |
| 9 | Nothing | Remaining disposable caches | Operational/diagnostic loaders |
| 10 | Fresh full-region acquisition | All required derivatives | Operations and cold-start readiness |
| 11 | Nothing | Cold acquisition/recovery rehearsal | Retire Flask |

### Increment 0: Build the comparison harness

The current server cannot be migrated incrementally merely by changing
`DB_PATH`: `_get_db()` and `_get_assets_db()` expose SQLite connections and
`serve_flask.py` performs direct SQL in multiple endpoints and workers. Before
acquiring or migrating data:

- Inventory every production `SELECT` by loader/endpoint/worker. Assign each
  query to exactly one increment below; fail CI when new direct SQL has no
  declared owner.
- Introduce a data-access interface at each promotion boundary (tile control,
  base DEM, texture, water, bathymetry, classifier, and assets). Provide legacy,
  destination, and comparing implementations.
- Move endpoint-level direct reads behind the appropriate interface. It is not
  necessary to rewrite unrelated writers yet.
- Make the comparing implementation invoke both readers with one normalized
  input, compare normalized outputs, record evidence, and return the legacy
  result.
- Ensure shadow reads are side-effect free. In particular, a shadow
  `/api/tiles` request must not enqueue a second DEM, texture, coastline,
  bathymetry, or Grundkort job or write a second seam/cache record.
- Add a fixture runner and a production-sampling comparator. The former proves
  deterministic artifacts offline; the latter proves real loader behavior and
  performance under representative requests.

The first code review should contain this seam and its tests, not production
data movement.

#### What a golden fixture is

A golden fixture is a frozen, named test case whose expected result was
produced by the current Flask implementation and reviewed as correct. It is
the migration's durable record of “what Flask does” for one declared set of
inputs. The replacement runs the same case and compares its result with the
recorded result using the fixture's declared comparison rule.

Each fixture must contain or identify all of the following:

- Immutable source inputs, such as provider bytes, source rasters, vectors,
  annotations, or sounding records. Large inputs may live in a
  content-addressed fixture store, but the fixture must record their hashes.
- Deterministic control inputs, including tile addresses, bounds, grid size,
  configuration values, recipe versions, and model or segmenter versions.
- Runtime inputs when relevant, such as the complete camera state, previous
  LOD state, client-resident tile set, or HTTP request.
- The expected Flask output: an array, mask, edge, selected leaf set, encoded
  image, response body, status code, or other observable result.
- A comparison rule: exact bytes or hashes, an explicit numeric tolerance,
  an image metric and threshold, or an exact structural/topological check.
- Provenance describing when and how the expected output was captured,
  including the Flask revision and the identities and hashes of its inputs.

A fixture is not merely a copy of a row from the live database, a screenshot,
or a request that still depends on a remote provider. It must be runnable
offline and must keep its source inputs separate from its expected derived
outputs. This prevents a replacement from passing by reading the legacy
derived value it is supposed to reproduce.

Golden outputs are reviewed baselines, not automatically refreshed snapshots.
When intentional behavior changes, update them in a dedicated change that
states why the old result is no longer authoritative. During parity work, a
difference is a migration failure until it is explained; the replacement must
never regenerate its own expected output.

One practical on-disk layout is a directory per named case containing a
manifest, `inputs/`, and `expected/`. The manifest records hashes, versions,
runtime parameters, and the comparator. The exact serialization may vary, but
the case must remain portable, deterministic, and independently reviewable.

Do not attempt to capture the entire system before moving any data. Before
each increment, add only the fixtures required by that increment. Across all
increments the fixture set must eventually cover:

- Tile parsing, bounds, parent/child relationships, and invalid addresses.
- Source heightmap decoding and hashes.
- Parent aggregation, child resampling, and cooked heightmaps.
- Equal-depth and mixed-depth edges.
- Land, coast, lake, fjord, and all-ocean tiles.
- Source, derived, missing, and provider-no-data cases.
- LOD results at representative positions, ranges, AGL values, and previous
  depth states.
- Texture source, crop, cook, and no-coverage cases.
- Bathymetry inside and outside effective water.
- The binary `/api/tiles` contract and relevant asset responses.

Fixtures must record source inputs independently of expected derived outputs.
The current Flask implementation is the parity oracle during migration.

Gate:

- The harness can execute a named Flask loader and its destination equivalent
  on the same frozen input.
- It emits a machine-readable mismatch report and fails on an undeclared
  tolerance.
- It proves rollback by changing one test loader from `destination` back to
  `legacy`.

Do not acquire or copy production records in this increment.

### Increment 1: Generate tile control and move safe metadata

Scope:

- Generate the `tiles` address fields (`tile_id`, `depth`, `col`, `row`,
  bounds, and `parent_id`) from `terrain_config.py`; do not copy them as source
  observations.
- Move only allowlisted deterministic `metadata` keys such as `bbox`,
  `grid_resolution`, and `max_depth`. Recipe-version keys are created by the
  destination recipes. Queue/failure keys remain in Flask until their worker
  moves.
- Do not move `sqlite_sequence`, `water_purge_audit`, or retired
  `terrain_artifact_*` tables.

Loaders to shadow:

- Tile parsing, `_tile_bbox`, parent/child traversal, and
  `database.read_tile_metadata`.
- `database.get_metadata` for each allowlisted key.

Gate:

- Generated IDs, bounds, parent links, and depth counts exactly match Flask.
- Missing and malformed tile IDs produce the same result.
- The importer rejects any `metadata` key not present in the reviewed
  allowlist.

Promote only the tile-control and allowlisted-metadata loaders. Flask still
reads all payload-bearing fields from SQLite.

### Increment 2: Reacquire DEM and negative DEM observations

Start with an empty destination DEM store. Define a bounded acquisition
manifest containing land, coast, ocean/no-data, provider-overlap, and provider-
fallback tiles. Run the replacement ArcticDEM and Copernicus acquisition code
for every request in the manifest.

Do not copy any `tiles.heightmap`, `confidence_map`, `geometric_error`, source
label, negative result, or acquisition timestamp from Flask. The legacy rows
with `arcticdem`, `arcticdem_10m`, `copernicus`, `unmasked_*`, and `no_data`
labels are comparison oracles only. The destination must independently:

- Fetch, decode, select, and persist provider responses.
- Produce its own provider identity, timestamp, content hash, confidence map,
  geometric error, and no-data observation.
- Exercise provider precedence, fallback, retry, timeout, corrupt-response,
  empty-response, and valid-response paths without clobbering a valid payload.
- Persist enough request provenance to repeat the acquisition from an empty
  store.

Loaders to shadow:

- `database.read_tile` in a base-height mode that does not yet compose water
  or bathymetry.
- `serve.load_no_data_cache`.
- Source selection and clobber-protection lookups used by DEM acquisition.

Verification corpus:

- At least one tile from each accepted source label, one `no_data` tile, one
  missing tile, and boundary tiles with non-null confidence maps.
- Request identity, provider outcome, decoded 65-by-65 float32 comparison,
  source family, extrema, NaN mask, confidence behavior, and geometric error.
  Compare payload hashes when the provider returned identical bytes; otherwise
  retain both hashes and review the semantic comparator.

Gate:

- Every manifest request has a reviewed success, terminal no-data, or expected
  failure result; no destination artifact originated from a Flask payload.
- Shadow loaders have zero unexplained differences.
- Deleting the destination slice and reacquiring it passes the same gate.

Promote the base DEM/no-data loaders and the destination DEM acquisition writer
together. Stop Flask DEM/COG acquisition before enabling destination demand.
Rollback stops destination acquisition and restores both Flask reads and its
acquisition worker; it never copies the legacy cache forward.

### Increment 3: Rebuild core terrain and verify `/api/tiles`

Create destination derived records from freshly acquired Increment 2 inputs;
do not import legacy derived `tiles` rows. Implement parent aggregation, child resampling,
deep `cooked_dem`, confidence-aware edge reconciliation, geometric error, LOD
selection, and seam repair. Create `terrain_seam_cache` empty and allow the
destination to populate it; never copy its rows.

Loaders to shadow:

- `serve.query_tiles_stereo`, including missing-demand decisions and ancestor
  fallback.
- `database.read_tile` for regions that do not require water composition yet.
- `serve_flask.api_tiles` in both JSON and binary modes, with texture,
  coastline, bathymetry, asset acquisition, and background writes disabled in
  the shadow request.

Gate:

- Rebuilt arrays and geometric errors match their golden comparators without
  reading a legacy derived row.
- Selected leaf IDs, repaired edges, missing IDs, binary framing, and residency
  digests match fixed camera fixtures.
- Changing one source DEM invalidates and rebuilds the expected parents,
  children, and seams.

Promote terrain reads first for a bounded, non-water test region, then expand
the region under the same loader flag. Do not promote global effective terrain
until Increment 5 passes.

### Increment 4: Reacquire provider textures

Start with an empty destination texture store and a bounded manifest covering
Sentinel-2, every active Dataforsyningen metatile path, provider no-coverage,
rate limiting, ancestor fallback, and all-ocean behavior.

Do not copy any `textures` row. Provider-labelled legacy rows and the hybrid
`ancestor_crop_nodata`/`ocean_nodata` rows are comparison oracles only. The
destination must independently fetch provider bytes, record coverage outcomes,
and generate fallback pixels. It must keep coverage facts separate from
generated JPEGs and record payload/input revisions before rebuilding crops or
cooks.

Loaders to shadow:

- `texture.read_texture`, `texture.texture_ids_in`, and
  `texture.texture_sources_in`.
- `/api/texture/<tile_id>.jpg` and the texture status fields returned by
  `/api/tiles`.

Gate:

- Every manifest request proves provider access and has a reviewed provider
  result; no destination JPEG originated from Flask storage.
- Rebuilt crops, splits, harmonization, and cooked upscales pass the declared
  image comparator.
- Changing a provider payload invalidates all descendant texture derivatives.

Promote texture reads and destination imagery acquisition together, after
stopping the corresponding Flask fetch workers. Rollback restores the Flask
reader/writer pair and discards the destination slice before the next attempt.

### Increment 5: Reacquire water sources and rebuild effective terrain

Scope:

- Starting empty, download representative hydrography WMS responses through
  the destination code and record request identity, dimensions, provider
  metadata, response hash, coverage, and timestamp.
- Starting without `gtk50_blocks/*.gpkg`, download the required GTK50 packages
  through the destination demand path and record their source URLs/dataset
  versions and hashes.
- Do not copy `hydrography_masks`, GTK50 files, or `coastline_masks` from
  Flask. Legacy copies are comparison oracles only; rasterize destination
  coastline masks from the newly downloaded packages.
- Move only water-related deterministic `metadata` allowlist entries. Create
  destination recipe versions from code, not from a blind metadata copy.

Loaders to shadow:

- Coastline and hydrography mask readers in `coastline.py`.
- `coastline.effective_heightmap` through `database.read_tile`.
- `/api/tiles` for land, coast, lake, fjord, and all-ocean fixtures, with
  bathymetry disabled.

Gate:

- WMS and GeoPackage acquisition succeeds from an empty cache. When provider
  bytes differ from the legacy oracle, record both hashes and verify decoded
  dimensions, coverage, geometry/raster semantics, and downstream output.
- Rebuilt masks match exactly or by the declared raster comparator.
- Water composition does not change the stored measured DEM bytes.
- Global `/api/tiles` shadow comparisons pass for non-bathymetric requests.

Promote destination WMS/GTK50 acquisition and water composition together after
stopping the Flask water-acquisition workers.

### Increment 6: Reacquire sounding evidence and rebuild bathymetry

Scope:

- Build an acquisition manifest from documented source URLs, record IDs,
  dataset selectors, and source-asset identities, but do not copy observation
  values or source payloads from `soundings`.
- Download and parse every required evidence source through the destination
  ingester. Recreate coordinates, depths, kinds, evidence corners, and source
  hashes from the downloaded material.
- Migrate only human curation that cannot be downloaded: `evidence_status`,
  curator-authored `evidence_note`, and any explicit override keyed by stable
  source identity. Reapply it after acquisition and report orphaned or changed
  identities for review.
- Recompute `stereo_x` and `stereo_y` and compare them.
- Do not copy `model_*`, `modeled_*`, `model_signature`, `model_health`, or
  comparison timestamps. Rebuild those fields as derived records.
- Do not copy `bathymetry`; run the destination solver from soundings and the
  promoted water inputs.
- Move `bathymetry_demand_paused` as operator state. Leave transient
  `bathymetry_demand_failure:*` keys behind.

Loaders to shadow:

- Sounding/evidence reads used by the bathymetry solver and health checks.
- `bathymetry_map.query_bathymetry_map` and `/api/bathymetry-map`.
- Effective-heightmap composition and `/api/tiles` with bathymetry enabled.

Gate:

- Every evidence source downloads and parses from an empty store. Evidence
  identities and semantic values reconcile or have a reviewed upstream-change
  record; migrated curation attaches to the intended reacquired record.
- A destination bathymetry purge and rebuild reproduces fixture grids.
- Bathymetry is applied only within the effective water mask and never mutates
  canonical land DEMs.

Promote evidence acquisition, bathymetry loaders, and composition together
after stopping the corresponding Flask ingest/demand workers.

### Increment 7: Move human classifier state and rebuild classifier output

Scope:

- Copy all `classifier_annotations` rows exactly; these are human source state.
- Do not copy `classifier_tiles` or `classifier_votes`; create them empty and
  rebuild from promoted terrain, texture, water, and annotation inputs.
- Register model, segmenter, and class-schema versions in destination control
  state.

Loaders to shadow:

- Annotation reads in `classifier/training.py`.
- Classifier storage readers and the routes registered by
  `classifier_routes.py`.
- Classifier channel/status fields used by tile-package, channel, cliff-graft,
  and pipeline inspection endpoints.

Gate:

- Annotation identity and timestamps reconcile exactly.
- Rebuilt class maps, confidence maps, votes, and verification outputs pass
  their artifact comparators.
- Deleting all destination classifier derivatives and rebuilding does not
  alter an annotation.

After the loader gate, quiesce the Flask annotation writer, replay its final
watermark, promote the destination annotation writer, and prove read-after-
write. Provider acquisition is not involved in this increment.

### Increment 8: Move assets and user-authored state

`assets` is another mixed table. Grundkort-derived feature rows must be
recreated from fresh downloads; only decisions and user-authored state move:

- Starting without local Grundkort archives or imported feature rows, download
  the required settlements through the destination demand path and rebuild
  source properties, projected rings/paths, and spatial indexes.
- Migrate imported-feature `enabled` decisions keyed by stable source feature
  identity, plus user-authored vehicle identity, pose/state, and timestamps.
  Report any decision whose reacquired feature identity no longer exists.
- Invalidate and resample building `z`, `groundZ`, `groundSampled`, and other
  terrain-derived enrichment.

Loaders to shadow:

- `asset_catalog.get_assets_response`, `asset_catalog.query_roads`,
  `buildings_query.buildings_for_tile_query`, and
  `vehicle_catalog.load_vehicle_assets`.
- `/api/assets`, `/api/roads`, `/api/buildings`, and the read-after-write result
  of `/api/vehicle_state`.

Gate:

- Grundkort acquisition and import succeed from an empty cache; counts and
  identities reconcile by asset type and settlement/archive or have a reviewed
  upstream-change record.
- Binary building footprints, road queries, enabled decisions, and vehicle
  state match.
- Terrain changes resample building ground data without changing imported
  geometry or user decisions.

After the loader gate, quiesce the Flask decision/vehicle writers, replay their
final watermark, promote destination mutable-state writers, and prove read-
after-write.

### Increment 9: Rebuild remaining disposable caches and operations

Create these tables empty in the destination and populate them only through
destination producers:

- `road_texture_bakes`
- `cliff_graft_assets`
- `terrain_seam_cache`
- `classifier_tiles`
- `classifier_votes`
- `coastline_masks`
- `bathymetry`

Do not recreate `water_purge_audit` or retired `terrain_artifact_*` lineage
unless a current consumer is first identified and documented.

Shadow the road-bake, cliff-graft, tile-package, pipeline-inspection, coverage,
health, client-log, and WebSocket loaders separately. Operational endpoints do
not block terrain read promotion unless the current client depends on them,
but each must have an explicit keep, replace, or retire decision.

Gate:

- A source-only rebuild populates every required cache without a legacy cache
  read.
- Cache invalidation follows recorded input revisions.
- Readiness distinguishes process, source-store, derived-store, recipe, and
  provider health.

### Increment 10: Prove a full cold acquisition and rebuild

Create a new isolated environment with empty source, derived, object, and job
stores. Do not mount `terrain.db`, `assets.db`, `gtk50_blocks`, downloaded
Grundkort archives, or any Flask payload/cache directory.

1. Generate deterministic tile control and import only reviewed human,
   operator, and user-authored state.
2. Run every provider acquisition manifest through destination code.
3. Expand acquisition from fixture cases to the complete declared initial
   operating region.
4. Rebuild all required terrain, texture, water, bathymetry, classifier, seam,
   road, cliff, and asset derivatives.
5. Run the full contract/artifact suite and production-shaped shadow requests.
6. Start the current web client against this environment and execute the
   flight/regression script.
7. Record elapsed time, request counts, provider failures/retries, coverage,
   artifact counts, and final hashes in the gate report.

The gate fails if any destination artifact was populated from Flask-downloaded
bytes or if an undocumented manual seed is required.

### Increment 11: Retire Flask

Flask becomes read-only after every loader and writer has its own promoted gate
record. Keep it available as an oracle through one complete cold rebuild
and the agreed compatibility window.

Final gate:

- The replacement reacquires every required provider domain from empty caches.
- Only reviewed human/operator/user state is imported from legacy storage.
- All required derived artifacts rebuild without legacy derived rows.
- Golden LOD, seam, terrain, texture, water, bathymetry, classification, and
  asset cases pass.
- The current web client operates against the replacement.
- Every source or user-state domain has exactly one authoritative writer.
- Backup/restore and post-promotion writer rollback have both been rehearsed.

## Domain implementation requirements

The increments above control when data and loaders move. The following domain
requirements control what the destination implementation must reproduce.

### Coordinate and tile control

Implement:

- EPSG:3413 root bounds.
- Tile ID parsing and formatting.
- Parent and child calculations.
- Tile bounding boxes.
- The 65 by 65 grid contract.
- Depth and provider-contract constants.

Exit criteria:

- All address fixtures match Flask.
- No database or network access is needed.

### Artifact identity and provenance

Implement source and derived artifact records, content hashing, recipe
versions, input edges, and invalidation. Do this before importing payloads so
the migration cannot create unclassified data.

Rules:

- Unknown source labels fail closed and require classification.
- Source artifacts are never silently overwritten by derived output.
- Derived artifacts never masquerade as provider source.
- A source change invalidates all transitive derivatives.
- Operator and human-authored fields have explicit preservation rules.

Exit criteria:

- A small synthetic dependency graph invalidates correctly.
- The source store can reject an attempted derived overwrite.
- Every current `tiles.source` and `textures.source` value is mapped.

### Base heightmaps

Implement and verify:

- Source heightmap decoding.
- Confidence-aware edge reconciliation.
- Parent aggregation.
- Child resampling.
- Cooked depth 13 through 16 terrain.
- Geometric-error calculation.
- Source precedence and clobber protection.

Do not read legacy parent-resampled or cooked rows while proving this phase.

Exit criteria:

- Rebuilt arrays match golden outputs within the declared tolerance.
- Derived artifacts record recipe versions and source input hashes.
- Updating a source tile invalidates affected parents, children, and seams.

### Water masks

Implement:

- GTK50 vector rasterization.
- Hydrography response reuse.
- Authoritative tidal-water masks.
- Connected-water rules.
- Effective water mask composition.
- Water-floor recipe versioning and invalidation.

Exit criteria:

- Golden coast, lake, fjord, and ocean masks match.
- Source DEM artifacts remain byte-identical before and after water processing.
- A vector or recipe change invalidates downstream render geometry.

### Bathymetry

Implement:

- Sounding evidence reads.
- Solver invocation and provenance.
- Depth-grid storage as derived artifacts.
- Water-constrained application.
- Sounding/model comparisons.
- Retry, pause, and failure control state.

Exit criteria:

- A bathymetry purge followed by rebuild reproduces the fixture output.
- Bathymetry is applied only inside the effective water mask.
- No bathymetry operation changes a canonical land heightmap.

### Effective render heightmaps

Compose, without mutating source inputs:

1. Best canonical land heightmap.
2. Effective water mask and synthetic water floor.
3. Valid bathymetry inside water.
4. Derived metadata needed for rendering.

Exit criteria:

- Land, synthetic seabed, and measured bathymetry cases match Flask.
- The output records all upstream input hashes.

### Textures

Implement:

- Provider image reads.
- Metatile splitting.
- Ancestor crops.
- Provider blowup detection.
- Cooked upscales.
- Separate negative-coverage facts and fallback pixels.
- Road bakes and cliff-graft derivations when their dependencies are ready.

Exit criteria:

- Source texture bytes remain immutable.
- Rebuilt derivatives match the image comparison thresholds.
- Replacing a provider image invalidates every dependent crop, cook,
  classification, road bake, and cliff graft.

### Classification

Implement terrain channels, segmentation, water priors, annotation binding,
predictions, class maps, votes, training, and verification outputs.

Exit criteria:

- Human annotations survive a complete derived reset.
- Segmenter/model/schema versions participate in artifact identity.
- Class maps rebuild from source annotations and retained terrain inputs.

### World-asset enrichment

Implement:

- Deterministic coordinate projection and normalized geometry.
- Terrain ground sampling for buildings.
- Roof-color derivation.
- Road masks and texture inputs.
- Distance-based building presentation LOD.

Keep source feature geometry, user decisions, and vehicle state separate from
these derivatives.

Exit criteria:

- Terrain changes invalidate sampled ground heights.
- Re-importing source geometry preserves user decisions.
- User-authored assets survive a complete derived reset.

### Runtime LOD

Implement the current quadtree selection policy:

- Distance-based depth ceiling.
- AGL cap and hysteresis.
- Depth-8 coarse rim.
- Depth-12 measured contract plateau.
- Bounded depth 13 through 16 cores.
- Best-available ancestor fallback.
- Missing-artifact demand output.

LOD must query artifact availability; it must not redefine whether an artifact
is source or derived.

Exit criteria:

- Selected leaf IDs match every golden camera fixture.
- The leaf set has no holes or overlaps.
- Missing artifacts generate the same demand without blocking the response.

### Seam repair

Repair the effective heightmaps for the actual variable-depth leaf set. Cache
results using the effective-heightmap hashes, neighbor identities, selected
depths, and seam recipe version.

Exit criteria:

- Equal-depth and mixed-depth boundaries match Flask.
- Updating heightmap, water, bathymetry, LOD-neighbor, or seam recipe inputs
  invalidates the cache.

### Response assembly

Reproduce the external contracts for:

- `/api/tiles` request parsing and binary payload.
- Residency digests.
- Heightmap, texture, water, bathymetry, and source-status metadata.
- Buildings, roads, assets, and vehicle state.
- Missing-artifact and background-demand signals.

Keep response formatting downstream of domain computation so transport changes
cannot alter terrain provenance.

Exit criteria:

- Golden API requests are compatible with the current web client.
- Semantic payload fields match Flask.
- Binary differences are explained or byte-identical where required.

### Operations

Implement:

- Source and derived job queues.
- Deduplication, concurrency limits, retries, and negative caches.
- Health and readiness endpoints.
- Pipeline and provenance inspection.
- Coverage and regression tools.
- Client logs, WebSocket delivery, and GPU-profile control if still required.

Readiness must distinguish:

- Service process ready.
- Source store readable.
- Derived store writable.
- Required recipes available.
- Optional external providers reachable.

## Verification strategy

Use four levels of comparison.

### Contract tests

Test tile IDs, coordinate bounds, payload schemas, enum/source labels, and API
errors without databases or networks.

### Artifact tests

Given frozen source inputs, compare individual derived artifacts using:

- Exact hashes for deterministic binary data where possible.
- Numeric tolerances for floating-point rasters.
- Pixel thresholds and perceptual metrics for encoded imagery.
- Exact topology and edge comparisons for tile boundaries.

### Shadow requests

Send the same camera and asset requests to Flask and the replacement. Compare:

- Selected tile IDs and depths.
- Fallback and missing-demand decisions.
- Heightmap extrema and hashes.
- Shared boundary samples.
- Texture and classifier status.
- Buildings and roads returned.
- Response latency and size.

The shadow path must not create two authoritative writers.

### Source-only rebuild test

This is the decisive migration test:

1. Start with an empty derived store.
2. Import only source artifacts and required control configuration.
3. Rebuild all artifacts needed by the golden regions.
4. Run contract, artifact, and shadow comparisons.
5. Confirm no legacy derived payload was read.

## Backup and retention policy

Back up:

- All source artifact payloads and provenance.
- Human annotations and operator decisions.
- User-authored assets and vehicle state.
- Source archives and GeoPackages.
- Required configuration and recipe-version declarations.

Do not require backups for rebuildable derived payloads, although retaining a
temporary cache may reduce recovery time.

Record remote source URLs and dataset versions, but do not assume those remote
objects will remain available or unchanged.

## Invalidation rules

At minimum:

- A DEM source change invalidates dependent aggregation, cooks, geometric
  error, effective terrain, seams, classifier channels, building ground
  samples, road bakes, and cliff grafts.
- A coastline or hydrography change invalidates effective-water masks,
  effective terrain, bathymetry composition, seams, and water-dependent
  classification.
- A sounding change invalidates its bathymetry solves and model comparisons,
  then effective terrain and seams in affected water tiles.
- A provider texture change invalidates crops, cooks, classifiers, roof
  colors, road bakes, and cliff grafts.
- A model, segmenter, or schema change invalidates its classifier derivatives,
  but never human annotations.
- A terrain recipe change invalidates terrain-dependent asset enrichment, but
  never imported geometry or user decisions.

Invalidation should follow recorded dependency edges rather than broad table
timestamps.

## Known migration hazards

- `tiles`, `textures`, `soundings`, `metadata`, and `assets` are mixed; copying
  or deleting them wholesale crosses provenance boundaries.
- Negative provider results are source facts even when the current row also
  contains derived fallback bytes.
- Classifier annotations are human source data despite referencing a derived
  segmentation identity.
- Building ground heights are derived fields stored beside source building
  geometry and are not currently covered by the terrain derived purge.
- Bathymetry is derived from source evidence and must never overwrite land DEM
  source payloads.
- Mixed-LOD seam results depend on runtime neighbors and cannot be generated
  correctly before LOD selection.
- Running Flask and the replacement as independent writers creates divergent
  source histories and an undefined rollback.

## Initial implementation milestone

The first end-to-end milestone is deliberately narrow:

> Import only source DEM tiles and deterministic tile configuration, rebuild
> parent/cooked heightmaps and geometric error, select the same LOD leaves for
> fixed camera states, repair their seams, and return a client-compatible tile
> response without reading any legacy derived row.

This proves the core dependency chain while preserving the source/derived
boundary. Coastline, bathymetry, textures, classification, and assets can then
be added in dependency order.

## Decisions still required

The following choices are intentionally left open until the destination system
is selected:

- Destination language and service framework.
- Relational, object, or hybrid storage for source payloads.
- Queue and worker implementation.
- Whether derived artifacts are stored eagerly or generated on demand.
- Whether the terrain, imagery, classification, and asset domains remain one
  deployable service or become separate services.
- Compatibility period and feature-flag mechanism for route-level cutover.

These decisions may change deployment topology, but they must not change the
provenance classes or dependency order defined above.
