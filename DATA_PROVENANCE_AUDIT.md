# Data provenance audit

Audited 2026-08-06 against the production schemas, writers, and the live
`flaskserver/terrain.db` and `assetserver/assets.db` files.

This inventory is explicitly column-level: every physical application column
present in either live database is listed below. Classifications are:

- **S (source)** — a locally retained recovery root: payload, observation, or
  durable negative fact sufficient to continue without going back to the
  cloud;
- **D (derived)** — a payload or value reproducible locally from retained
  source data and code;
- **C (control)** — schema, address, configuration, queue, or operator state;
- **P (provenance)** — identity, timestamp, or diagnostic metadata that
  explains a payload but cannot replace it or prevent a cloud fetch by itself;
  and
- **M (mixed)** — classification varies by row, discriminator, or JSON member.

Where the row discriminator is known, the tables below use composite labels
such as **S/P/D/C** instead of hiding the constituent classes behind M.

Within each table, rows are ordered by population dependency: source facts and
provenance first, identity/configuration next, and values computed from those
inputs last. **Initial writer** names the production file containing the SQL
INSERT or first non-default UPDATE; it is not a list of every later mutator.

“Preserve” and “reset/delete” describe the intended `purge_derived.py`
contract. A locator marked C may be deleted with the derived row it identifies;
the classification does not by itself require retaining an otherwise derived
row.

### Recovery-driven storage rule

Classification is not the design goal by itself. A stored fact or derivative
is justified by the recovery decision it enables. For every partially populated
or stale row, the durable state should answer:

1. What trustworthy payload can be served now, if any?
2. Is absence confirmed by an external provider, merely not attempted, or the
   result of a transient failure?
3. Can the missing/stale payload be rebuilt locally, and from which exact input
   revisions?
4. If an external retry is required, what was attempted, when may it run again,
   and what retry history must survive a process restart?
5. Which rows must be invalidated when an input changes, without discarding an
   independent provider fact?

A schema that cannot answer those questions is incomplete even if every
existing column has been labeled S, P, D, C, or M. Purge behavior must follow the
same rule: remove locally rebuildable materializations and recovery control
that should restart, while retaining external observations and enough lineage
to invalidate or rebuild selectively.

## `terrain.db`

### `tiles`

`source` is the row discriminator. Provider DEM, `no_data`, and `unmasked_*`
rows are retained; parent-resampled, cooked, coastline-only, and retired
clobbered payloads are reset to `pending` while retaining their scaffold.

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `source` | `TEXT` | S/P/D/C | `flaskserver/database.py` | Durable no-coverage fact (S), provider identity/state attached to cached bytes (P), generated-payload label (D), or empty/pending state (C); preserve retained values, change derived values to `pending`. |
| `heightmap` | `BLOB` | S/D | `flaskserver/database.py` | Locally cached provider/measurement data that cannot be rebuilt without its remote source (S), or generated terrain (D); preserve or clear by `source`. |
| `tile_id` | `TEXT` | C | `flaskserver/database.py` | Deterministic quadtree address; preserve every row. |
| `depth` | `INTEGER` | C | `flaskserver/database.py` | Address component; preserve. |
| `col` | `INTEGER` | C | `flaskserver/database.py` | Address component; preserve. |
| `row` | `INTEGER` | C | `flaskserver/database.py` | Address component; preserve. |
| `x_min` | `REAL` | C | `flaskserver/database.py` | Deterministic projected bound; preserve. |
| `y_min` | `REAL` | C | `flaskserver/database.py` | Deterministic projected bound; preserve. |
| `x_max` | `REAL` | C | `flaskserver/database.py` | Deterministic projected bound; preserve. |
| `y_max` | `REAL` | C | `flaskserver/database.py` | Deterministic projected bound; preserve. |
| `parent_id` | `TEXT` | C | `flaskserver/database.py` | Deterministic hierarchy link; preserve. |
| `dem_demanded_at` | `TEXT` | C | `flaskserver/serve_flask.py` | Demand queue state; preserve retained rows, clear derived rows so demand can rebuild them. |
| `dem_requested_at` | `TEXT` | C | `flaskserver/serve_flask.py` | Request scheduler state; preserve retained rows, clear derived rows. |
| `cog_requested_at` | `TEXT` | C | `flaskserver/serve_flask.py` | Remote COG request state; preserve retained rows, clear derived rows. |
| `confidence_map` | `BLOB` | D | `flaskserver/database.py` | Locally constructed processing/confidence companion, including for provider DEM rows; preserve with retained heightmaps, clear with derived heightmaps. |
| `geometric_error` | `REAL` | D | `flaskserver/database.py` | Locally computed payload summary; preserve with retained payloads, reset to zero on derived rows. |
| `updated_at` | `TEXT` | P | `flaskserver/database.py` | Acquisition, generation, or state-transition timestamp. It supports freshness decisions but contains neither the payload nor a negative cloud result; preserve retained rows, replace when resetting derived rows. |

The row-specific boundary is:

| `tiles.source` family | `source` | `heightmap` | `confidence_map` | `geometric_error` | `updated_at` |
|---|---:|---:|---:|---:|---:|
| `arcticdem`, `arcticdem_10m`, `copernicus` | P | S | D | D | P |
| `unmasked_arcticdem*`, `unmasked_copernicus` | P/C | S | D | D | P |
| `no_data` | S | — | — | D | P |
| `empty`, `pending` | C | — | — | D | P |
| parent-resampled, cooked, coastline, clobbered families | D | D | D | D | P |

### `textures`

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `source` | `TEXT` | S/P/D | `flaskserver/texture.py` | Confirmed no-coverage state (S), provider identity attached to cached bytes (P), or transformation/state label for generated textures (D). `ancestor_crop*` and `cooked_upscale` do not identify their input tile or input revision; provider and terminal negative-cache values are retained, crops/cooks are deleted. |
| `texture` | `BLOB` | S/D | `flaskserver/texture.py` | Provider response bytes (S), generated crop/upscale bytes (D), or generated fallback bytes retained alongside a source no-coverage fact (D); treatment follows `source`. |
| `tile_id` | `TEXT` | C | `flaskserver/texture.py` | Quadtree address; keep only when the texture row is retained. |
| `updated_at` | `TEXT` | P | `flaskserver/texture.py` | Acquisition or materialization timestamp. It is not itself source data; for crops it is not the parent revision time and therefore cannot prove freshness. Treatment follows the row. |

The row-specific boundary is:

| `textures.source` family | `source` | `texture` | `updated_at` |
|---|---:|---:|---:|
| `sentinel2`, `dataforsyningen*` | P | S | P |
| `ancestor_crop_nodata`, `ocean_nodata` | S | D | P |
| `sentinel2_crop`, `ancestor_crop`, `ancestor_crop_ratelimit`, `cooked_upscale`, `fractal_upscale` | D | D | P |

`ancestor_crop_nodata` and `ocean_nodata` are deliberately hybrid. Their
`source` value records a terminal provider no-coverage result (S), while their
`texture` bytes are a parent crop or synthetic ocean fill (D). The rows are
retained to avoid repeating network requests. A cleaner schema would store the
coverage result separately from fallback imagery.

#### Missing texture lineage

The four physical columns above cannot express the dependency of a generated
texture. `_seed_children_from_parent()` in `flaskserver/serve_flask.py` crops a
parent and calls `write_texture()` with only the child ID, bytes, and the label
`ancestor_crop`. `write_texture()` stamps a new child `updated_at`; it does not
store which parent revision supplied the pixels.

This is a correctness gap, not merely missing audit detail. When a parent gets
better imagery, `drop_procedural_children()` in `flaskserver/texture.py`
invalidates only descendants whose current `source` is `cooked_upscale`. It
cannot select `ancestor_crop`, `ancestor_crop_ratelimit`, or
`ancestor_crop_nodata` rows by dependency. In particular, a terminal
`ancestor_crop_nodata` row can keep an old fallback crop after its parent has
changed.

The missing information should be designed from the recovery cases rather than
added indiscriminately to `textures`. Logically, texture state has three
separable records:

- a **provider observation**: coverage/result and when it was observed;
- a **servable materialization**: provider bytes or a fallback/cook, with an
  identity and exact input revisions; and
- **recovery control**: pending/transient state, retry schedule, and failure
  history.

Keeping these logical records separate prevents deletion of a stale fallback
from erasing a valid provider no-coverage observation.

The recovery decisions for current states are:

| Current state | Serve now | Durable fact to retain | Recovery action | Present gap |
|---|---|---|---|---|
| no row | Nothing, or an uncached ancestor fallback | None | Attempt provider; optionally materialize a traced fallback | No durable attempted/pending state. |
| `ancestor_crop` | Parent-derived fallback | Exact input revision | Fetch provider; regenerate if input changes | Input tile/revision absent. |
| `ancestor_crop_ratelimit` | Parent-derived fallback | Transient provider outcome plus exact input revision | Retry after durable backoff; regenerate fallback if input changes | Attempt count, failure class, and retry time are memory-only; input revision absent. |
| `ancestor_crop_nodata` | Parent-derived fallback | Provider no-coverage observation plus exact input revision | Do not refetch solely for absence; regenerate fallback if input changes | Observation and fallback are fused; input revision absent. |
| `ocean_nodata` | Synthetic ocean fill | Provider no-coverage observation | Regenerate if terrain/coastline inputs change | Observation and generated fill are fused; terrain/mask revisions absent. |
| `cooked_upscale` | Cooked parent-derived payload | Exact input revision and recipe | Rebuild when input or recipe changes | Parent identity/revision absent; invalidation relies on tree shape and source labels. |
| provider payload | Provider bytes | Provider identity, acquisition result, and payload identity | Serve; refresh only under explicit provider policy | `source` and `updated_at` provide coarse provenance but no explicit provider response identity. |
| corrupt/unreadable payload | Nothing | Provider observation and failure diagnosis | Drop only bad materialization, then refetch or rebuild according to provenance | Corruption is not a distinct durable state. |

The corresponding logical fields below are proposed; they are not columns in
the current live schema:

| Logical field | SQLite type | Recovery purpose | Initial writer |
|---|---|---|---|
| `provider` | `TEXT` | Identifies which external service was queried independently of the payload producer. | Provider fetch path in `flaskserver/serve_flask.py` |
| `coverage_status` | `TEXT` | Distinguishes `unknown`, `available`, and confirmed `no_coverage`. | Provider fetch path in `flaskserver/serve_flask.py` |
| `coverage_observed_at` | `TEXT` | Ages or refreshes the provider observation without conflating it with fallback creation. | Provider fetch path in `flaskserver/serve_flask.py` |
| `payload_kind` | `TEXT` | Distinguishes provider bytes, ancestor crop, cook, and synthetic fill. | `flaskserver/texture.py` |
| `payload_revision` | `TEXT` | Stable identity of the servable bytes, preferably their SHA-256. | `flaskserver/texture.py` |
| `input_tile_id` | `TEXT` | Exact parent/ancestor tile whose pixels were used. | `flaskserver/texture.py` (value supplied by `serve_flask.py`) |
| `input_revision` | `TEXT` | Exact payload revision consumed; stronger and clearer than comparing timestamps. | `flaskserver/texture.py` (value supplied by `serve_flask.py`) |
| `recipe_version` | `INTEGER` | Forces local rebuild when crop/cook behavior changes. | `flaskserver/texture.py` |
| `recovery_status` | `TEXT` | Distinguishes idle, pending, and transient failure without overloading payload provenance. | `flaskserver/serve_flask.py` |
| `attempt_count` | `INTEGER` | Preserves capped-backoff progress across restart. | `flaskserver/serve_flask.py` |
| `retry_after` | `TEXT` | Makes the next permissible provider attempt durable and schedulable. | `flaskserver/serve_flask.py` |
| `last_failure_class` | `TEXT` | Selects retry, operator intervention, or corruption recovery without storing credentials/error bodies. | `flaskserver/serve_flask.py` |

`source` should remain the producer/state discriminator; it should not be
overloaded with provider observation, dependency identity, and retry control.
On input replacement, invalidation can traverse materializations whose
`input_tile_id` and `input_revision` match the old payload, including terminal
negative-coverage rows whose fallback bytes are derived. The independent
coverage observation survives and tells recovery not to perform a redundant
provider request.

### `coastline_masks`

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `tile_id` | `TEXT` | C | `flaskserver/coastline.py` | Address of a generated raster; delete with row. |
| `source` | `TEXT` | D | `flaskserver/coastline.py` | Provenance label for the generated raster, not the source vector payload; delete. |
| `version` | `INTEGER` | C | `flaskserver/coastline.py` | Raster recipe version; delete. |
| `mask` | `BLOB` | D | `flaskserver/coastline.py` | Rasterized local GTK50 coastline vectors; delete. |
| `width` | `INTEGER` | D | `flaskserver/coastline.py` | Generated raster dimension; delete. |
| `height` | `INTEGER` | D | `flaskserver/coastline.py` | Generated raster dimension; delete. |
| `updated_at` | `TEXT` | P | `flaskserver/coastline.py` | Generation-run timestamp; delete with the materialization. |

### `hydrography_masks`

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `source` | `TEXT` | P | `flaskserver/coastline.py` | Provider/layer identity attached to the retained response; preserve. |
| `mask` | `BLOB` | S | `flaskserver/coastline.py` | Downloaded WMS rendering; preserve to avoid another request. |
| `updated_at` | `TEXT` | P | `flaskserver/coastline.py` | Acquisition timestamp; preserve with the response. |
| `tile_id` | `TEXT` | C | `flaskserver/coastline.py` | Address used for the WMS request; preserve. |
| `version` | `INTEGER` | C | `flaskserver/coastline.py` | Local interpretation recipe version; preserve with cached source response. |
| `width` | `INTEGER` | C | `flaskserver/coastline.py` | Requested/rendered response width; preserve with response. |
| `height` | `INTEGER` | C | `flaskserver/coastline.py` | Requested/rendered response height; preserve with response. |

### `bathymetry`

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `tile_id` | `TEXT` | C | `flaskserver/bathymetry.py` | Address of a solve; delete with row. |
| `source` | `TEXT` | D | `flaskserver/bathymetry.py` | Provenance label for the generated solve, not independent evidence; delete. |
| `version` | `INTEGER` | C | `flaskserver/bathymetry.py` | Solver recipe version; delete. |
| `heightmap` | `BLOB` | D | `flaskserver/bathymetry.py` | Solver output from retained sounding evidence; delete. |
| `water_px` | `INTEGER` | D | `flaskserver/bathymetry.py` | Output summary; delete. |
| `min_z` | `REAL` | D | `flaskserver/bathymetry.py` | Output summary; delete. |
| `max_z` | `REAL` | D | `flaskserver/bathymetry.py` | Output summary; delete. |
| `updated_at` | `TEXT` | P | `flaskserver/bathymetry.py` | Solve-run timestamp; delete with the materialization. |

### `soundings`

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `source_url` | `TEXT` | P | `flaskserver/ingest_depth_evidence.py` | External evidence identity; preserve with the locally retained measurement. |
| `record_id` | `TEXT` | P | `flaskserver/ingest_depth_evidence.py` | Source record identity; preserve with the locally retained measurement. |
| `latitude` | `REAL` | S | `flaskserver/ingest_depth_evidence.py` | Observed/reported position; preserve. |
| `longitude` | `REAL` | S | `flaskserver/ingest_depth_evidence.py` | Observed/reported position; preserve. |
| `depth_m` | `REAL` | S | `flaskserver/ingest_depth_evidence.py` | Observed/charted depth; preserve. |
| `depth_kind` | `TEXT` | S | `flaskserver/ingest_depth_evidence.py` | Source evidence semantics (`actual`/`at_least`); preserve. |
| `evidence_status` | `TEXT` | S | `flaskserver/database.py` (default) | Curated acceptance/rejection decision; preserve. |
| `evidence_note` | `TEXT` | S | `flaskserver/ingest_depth_evidence.py` | Curator/source note; preserve. |
| `evidence_format` | `TEXT` | S | `flaskserver/ingest_depth_evidence.py` | Source evidence format; preserve. |
| `source_asset` | `TEXT` | P | `flaskserver/ingest_depth_evidence.py` | External source asset identity; preserve, but it cannot replace an absent asset by itself. |
| `source_sha256` | `TEXT` | P | `flaskserver/ingest_depth_evidence.py` | External source asset fingerprint; preserve, but the hash is not the source payload. |
| `evidence_sw_m` | `REAL` | S | `flaskserver/ingest_depth_evidence.py` | Source evidence corner sample; preserve. |
| `evidence_se_m` | `REAL` | S | `flaskserver/ingest_depth_evidence.py` | Source evidence corner sample; preserve. |
| `evidence_nw_m` | `REAL` | S | `flaskserver/ingest_depth_evidence.py` | Source evidence corner sample; preserve. |
| `evidence_ne_m` | `REAL` | S | `flaskserver/ingest_depth_evidence.py` | Source evidence corner sample; preserve. |
| `created_at` | `TEXT` | P | `flaskserver/database.py` (default) | Ingestion timestamp; preserve. |
| `comparison_method` | `TEXT` | C | `flaskserver/ingest_depth_evidence.py` | Selected comparison algorithm/configuration; preserve. |
| `stereo_x` | `REAL` | D | `flaskserver/ingest_depth_evidence.py` | Deterministic EPSG:3413 transform of source position; preserve as a source-cache index. |
| `stereo_y` | `REAL` | D | `flaskserver/ingest_depth_evidence.py` | Deterministic EPSG:3413 transform of source position; preserve as a source-cache index. |
| `model_tile_id` | `TEXT` | D | `flaskserver/bathymetry_health.py` | Compared model locator; clear. |
| `model_source` | `TEXT` | D | `flaskserver/bathymetry_health.py` | Compared model provenance; clear. |
| `model_version` | `INTEGER` | D | `flaskserver/bathymetry_health.py` | Compared model recipe version; clear. |
| `model_updated_at` | `TEXT` | P | `flaskserver/bathymetry_health.py` | Compared model generation timestamp; clear. |
| `modeled_depth_m` | `REAL` | D | `flaskserver/bathymetry_health.py` | Model comparison output; clear. |
| `modeled_sw_m` | `REAL` | D | `flaskserver/bathymetry_health.py` | Model corner sample; clear. |
| `modeled_se_m` | `REAL` | D | `flaskserver/bathymetry_health.py` | Model corner sample; clear. |
| `modeled_nw_m` | `REAL` | D | `flaskserver/bathymetry_health.py` | Model corner sample; clear. |
| `modeled_ne_m` | `REAL` | D | `flaskserver/bathymetry_health.py` | Model corner sample; clear. |
| `model_sample_count` | `INTEGER` | D | `flaskserver/bathymetry_health.py` | Comparison output count; reset to zero. |
| `model_signature` | `TEXT` | D | `flaskserver/bathymetry_health.py` | Fingerprint of compared generated model; clear. |
| `model_delta_m` | `REAL` | D | `flaskserver/bathymetry_health.py` | Model comparison output; clear. |
| `model_error_m` | `REAL` | D | `flaskserver/bathymetry_health.py` | Model comparison output; clear. |
| `model_health` | `TEXT` | D | `flaskserver/bathymetry_health.py` | Model comparison classification; reset to `white`. |
| `compared_at` | `TEXT` | P | `flaskserver/bathymetry_health.py` | Comparison-run timestamp; clear. |
| `comparison_revision` | `INTEGER` | C | `flaskserver/database.py` (default); `flaskserver/bathymetry_health.py` | Rebuild guard/control counter; increment when comparison fields are reset. |

### `classifier_annotations`

The label and its target identity jointly describe locally retained human
training evidence; `updated_at` is provenance for that source record. All five
columns remain when generated classifier outputs are purged.

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `class_name` | `TEXT` | S | `flaskserver/classifier/training.py` | Human classification; preserve. |
| `tile_id` | `TEXT` | S | `flaskserver/classifier/training.py` | Annotation target identity; preserve. |
| `segmenter_version` | `TEXT` | S | `flaskserver/classifier/training.py` | Version that defines the labeled segment; preserve. |
| `segment_id` | `INTEGER` | S | `flaskserver/classifier/training.py` | Exact segment selected by the human; preserve. |
| `updated_at` | `TEXT` | P | `flaskserver/classifier/training.py` | Human-edit timestamp; preserve with the annotation. |

### `classifier_tiles`

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `tile_id` | `TEXT` | C | `flaskserver/classifier/storage.py` | Address of classifier output; delete with row. |
| `source` | `TEXT` | D | `flaskserver/classifier/storage.py` | Provenance label for generated classifier output; delete. |
| `class_schema` | `TEXT` | C | `flaskserver/classifier/storage.py` | Output schema/recipe identifier; delete. |
| `class_map` | `BLOB` | D | `flaskserver/classifier/storage.py` | Classifier output; delete. |
| `confidence_map` | `BLOB` | D | `flaskserver/classifier/storage.py` | Classifier output; delete. |
| `width` | `INTEGER` | D | `flaskserver/classifier/storage.py` | Output dimension; delete. |
| `height` | `INTEGER` | D | `flaskserver/classifier/storage.py` | Output dimension; delete. |
| `updated_at` | `TEXT` | P | `flaskserver/classifier/storage.py` | Generation-run timestamp; delete with the materialization. |

### `classifier_votes`

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `tile_id` | `TEXT` | C | `flaskserver/classifier/storage.py` | Address of aggregation output; delete with row. |
| `source` | `TEXT` | D | `flaskserver/classifier/storage.py` | Provenance label for generated vote output; delete. |
| `class_schema` | `TEXT` | C | `flaskserver/classifier/storage.py` | Vote schema/recipe identifier; delete. |
| `vote_map` | `BLOB` | D | `flaskserver/classifier/storage.py` | Aggregated semantic votes; delete. |
| `vote_count` | `INTEGER` | D | `flaskserver/classifier/storage.py` | Aggregation count; delete. |
| `width` | `INTEGER` | D | `flaskserver/classifier/storage.py` | Output dimension; delete. |
| `height` | `INTEGER` | D | `flaskserver/classifier/storage.py` | Output dimension; delete. |
| `updated_at` | `TEXT` | P | `flaskserver/classifier/storage.py` | Generation-run timestamp; delete with the materialization. |

### `road_texture_bakes`

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `tile_id` | `TEXT` | C | `flaskserver/road_texture_cache.py` | Address of generated bake; delete with row. |
| `recipe_version` | `INTEGER` | C | `flaskserver/road_texture_cache.py` | Bake recipe version; delete. |
| `source_fingerprint` | `TEXT` | D | `flaskserver/road_texture_cache.py` | Fingerprint of bake inputs; delete. |
| `texture` | `BLOB` | D | `flaskserver/road_texture_cache.py` | Provider texture composited with retained road vectors; delete. |
| `road_count` | `INTEGER` | D | `flaskserver/road_texture_cache.py` | Input/output summary; delete. |
| `updated_at` | `TEXT` | P | `flaskserver/road_texture_cache.py` | Generation-run timestamp; delete with the materialization. |

### `cliff_graft_assets`

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `donor_tile_id` | `TEXT` | C | `flaskserver/cliff_graft_cache.py` | Address of generated donor asset; delete with row. |
| `recipe_version` | `INTEGER` | C | `flaskserver/cliff_graft_cache.py` | Graft recipe version; delete. |
| `source_fingerprint` | `TEXT` | D | `flaskserver/cliff_graft_cache.py` | Fingerprint of generated inputs; delete. |
| `texture` | `BLOB` | D | `flaskserver/cliff_graft_cache.py` | Prepared donor texture; delete. |
| `width` | `INTEGER` | D | `flaskserver/cliff_graft_cache.py` | Output dimension; delete. |
| `height` | `INTEGER` | D | `flaskserver/cliff_graft_cache.py` | Output dimension; delete. |
| `water_pixels` | `INTEGER` | D | `flaskserver/cliff_graft_cache.py` | Generated output summary; delete. |
| `updated_at` | `TEXT` | P | `flaskserver/cliff_graft_cache.py` | Generation-run timestamp; delete with the materialization. |

### `terrain_seam_cache`

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `tile_a` | `TEXT` | C | `flaskserver/terrain_seams.py` | First generated terrain address; delete with row. |
| `direction` | `TEXT` | C | `flaskserver/terrain_seams.py` | Edge relation; delete. |
| `tile_b` | `TEXT` | C | `flaskserver/terrain_seams.py` | Neighbor generated terrain address; delete. |
| `edge` | `BLOB` | D | `flaskserver/terrain_seams.py` | Repaired effective-heightmap edge; delete. |
| `updated_at` | `TEXT` | P | `flaskserver/terrain_seams.py` | Generation-run timestamp; delete with the materialization. |

### `water_purge_audit`

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `tile_id` | `TEXT` | C | No current production writer | Address of audited derived cook; delete with row. |
| `recipe_version` | `INTEGER` | C | No current production writer | Derived cook/audit recipe version; delete. |
| `recooked_updated_at` | `TEXT` | P | No current production writer | Generation timestamp for the audited cook; delete. |
| `audited_at` | `TEXT` | P | No current production writer | Audit-run timestamp for that cook; delete. |

### `metadata`

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `key` | `TEXT` | C | `flaskserver/database.py`; `flaskserver/bathymetry_demand.py`; `flaskserver/coastline.py`; `flaskserver/serve_flask.py` | Configuration/state discriminator; preserve except `bathymetry_demand_failure:*`. |
| `value` | `TEXT` | M | `flaskserver/database.py`; `flaskserver/bathymetry_demand.py`; `flaskserver/coastline.py`; `flaskserver/serve_flask.py` | `bbox`, `grid_resolution`, `max_depth`, schema/recipe versions are C; `bathymetry_demand_paused` is operator C; `bathymetry_demand_failure:*` is transient derived retry state and is deleted. |

### Retired `terrain_artifact_*` lineage

These tables mix retained provider revisions with derived crop/cook revisions.
For revision-linked columns, “M” means preserve provider-only lineage and
delete rows that reference a derived revision. The live database currently has
137 provider revisions and 732 derived `ancestor_crop` revisions.

#### `terrain_artifact_revisions`

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `source_label` | `TEXT` | P/D | No current production writer | Provider identity metadata (P) or generated-artifact label (D); discriminator used by the purge, but not a recovery root without payload bytes. |
| `payload_sha256` | `TEXT` | P/D | No current production writer | Fingerprint of a provider payload (P) or generated payload (D); treatment follows revision, but the hash alone cannot avoid a cloud fetch. |
| `metadata_json` | `TEXT` | M | No current production writer | Provider or generated revision metadata; treatment follows revision. |
| `producer` | `TEXT` | M | No current production writer | Acquisition or generation provenance; treatment follows revision. |
| `revision_id` | `TEXT` | M | No current production writer | Identity of a provider or generated revision; preserve/delete according to `source_label`. |
| `artifact_kind` | `TEXT` | M | No current production writer | Kind of retained or generated artifact; treatment follows revision. |
| `tile_id` | `TEXT` | C | No current production writer | Artifact address; treatment follows revision. |
| `depth` | `INTEGER` | C | No current production writer | Address component; treatment follows revision. |
| `col` | `INTEGER` | C | No current production writer | Address component; treatment follows revision. |
| `row` | `INTEGER` | C | No current production writer | Address component; treatment follows revision. |
| `quality_class` | `TEXT` | M | No current production writer | Revision quality metadata; treatment follows revision, not this field. |
| `lineage_status` | `TEXT` | M | No current production writer | Revision lineage state; treatment follows revision. |
| `created_at` | `TEXT` | P | No current production writer | Acquisition or generation timestamp; treatment follows revision. |

#### `terrain_artifact_inputs`

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `input_revision_id` | `TEXT` | M | No current production writer | Input lineage reference; delete edge if this or the output revision is derived. |
| `output_revision_id` | `TEXT` | M | No current production writer | Output lineage reference; delete edge if this or the input revision is derived. |
| `input_role` | `TEXT` | M | No current production writer | Role in provider or generated lineage; treatment follows edge. |
| `ordinal` | `INTEGER` | C | No current production writer | Deterministic edge ordering; treatment follows edge. |
| `transform` | `TEXT` | M | No current production writer | Recorded lineage transform; treatment follows edge. |
| `transform_json` | `TEXT` | M | No current production writer | Transform parameters/provenance; treatment follows edge. |

#### `terrain_artifact_current`

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `revision_id` | `TEXT` | M | No current production writer | Mutable current pointer; delete if it points to a derived revision. |
| `artifact_kind` | `TEXT` | M | No current production writer | Kind of current provider or generated artifact; treatment follows revision. |
| `tile_id` | `TEXT` | C | No current production writer | Artifact address; treatment follows revision. |

#### `terrain_artifact_events`

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `from_revision_id` | `TEXT` | M | No current production writer | Prior revision reference; delete event if either reference is derived. |
| `to_revision_id` | `TEXT` | M | No current production writer | New revision reference; delete event if either reference is derived. |
| `event_type` | `TEXT` | M | No current production writer | Provider-lineage or generated-lineage event; treatment follows event. |
| `reason` | `TEXT` | M | No current production writer | Provider or generated transition provenance; treatment follows event. |
| `artifact_kind` | `TEXT` | M | No current production writer | Kind of provider or generated artifact; treatment follows event. |
| `tile_id` | `TEXT` | C | No current production writer | Artifact address; treatment follows event. |
| `event_id` | `INTEGER` | C | No current production writer | Local event identity; delete event if either revision reference is derived. |
| `created_at` | `TEXT` | P | No current production writer | Provider acquisition or generated transition timestamp; treatment follows event. |

### `sqlite_sequence`

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `name` | `undeclared` | C | SQLite engine | SQLite-owned AUTOINCREMENT table name; leave to SQLite. |
| `seq` | `undeclared` | C | SQLite engine | SQLite-owned next-ID state; leave to SQLite. |

## `assets.db`

The `assets` table is row-dependent: imported `BYGNING`, `VEJMIDTE`, and
`STIMIDTE` records cache Asiaq source data; `KØRETØJ` is user-authored state.

### `assets`

| Column | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `id` | `TEXT` | S | `flaskserver/ingest_buildings.py`; `flaskserver/ingest_roads.py`; `flaskserver/vehicle_catalog.py`; `flaskserver/asset_catalog.py` | Imported source identity or user-authored asset identity; preserve. |
| `type` | `TEXT` | S | `flaskserver/ingest_buildings.py`; `flaskserver/ingest_roads.py`; `flaskserver/vehicle_catalog.py`; `flaskserver/asset_catalog.py` | Imported feature type or user-selected asset type; preserve. |
| `enabled` | `INTEGER` | S | `flaskserver/ingest_buildings.py`; `flaskserver/ingest_roads.py`; `flaskserver/vehicle_catalog.py`; `flaskserver/asset_catalog.py` | Human/operator decision; preserve across import and terrain rebuilds. |
| `lat` | `REAL` | M | `flaskserver/ingest_buildings.py`; `flaskserver/ingest_roads.py`; `flaskserver/vehicle_catalog.py`; `flaskserver/asset_catalog.py` | Deterministically transformed imported geometry center (D) or user-authored vehicle position (S); preserve. |
| `lon` | `REAL` | M | `flaskserver/ingest_buildings.py`; `flaskserver/ingest_roads.py`; `flaskserver/vehicle_catalog.py`; `flaskserver/asset_catalog.py` | Deterministically transformed imported geometry center (D) or user-authored vehicle position (S); preserve. |
| `heading_deg` | `REAL` | M | `flaskserver/ingest_buildings.py`; `flaskserver/ingest_roads.py`; `flaskserver/vehicle_catalog.py`; `flaskserver/asset_catalog.py` | User-authored vehicle pose (S) or importer/default state (C); preserve. |
| `z` | `REAL` | M | `flaskserver/ingest_buildings.py`; `flaskserver/ingest_roads.py`; `flaskserver/vehicle_catalog.py`; `flaskserver/asset_catalog.py` | Building ground height sampled from terrain (D), user-authored vehicle height (S), or null for linear assets; building values need invalidation/resampling, not row deletion. |
| `properties` | `TEXT` | M | `flaskserver/ingest_buildings.py`; `flaskserver/ingest_roads.py`; `flaskserver/vehicle_catalog.py`; `flaskserver/asset_catalog.py` | JSON container detailed below; preserve source/user members, resample derived building-ground members. |
| `saved_at` | `REAL` | P | `flaskserver/vehicle_catalog.py` | User save timestamp for authored assets; null for imports; preserve. |
| `updated_at` | `TEXT` | P | `flaskserver/ingest_buildings.py`; `flaskserver/ingest_roads.py`; `flaskserver/vehicle_catalog.py`; `flaskserver/asset_catalog.py` | Import/edit timestamp; preserve. |
| `cx` | `REAL` | D | `flaskserver/ingest_buildings.py`; `flaskserver/ingest_roads.py` | Deterministic EPSG:3413 center/index coordinate; preserve as source-cache index. |
| `cy` | `REAL` | D | `flaskserver/ingest_buildings.py`; `flaskserver/ingest_roads.py` | Deterministic EPSG:3413 center/index coordinate; preserve as source-cache index. |
| `min_x` | `REAL` | D | `flaskserver/ingest_buildings.py`; `flaskserver/ingest_roads.py` | Deterministic projected geometry bound; preserve as source-cache index. |
| `min_y` | `REAL` | D | `flaskserver/ingest_buildings.py`; `flaskserver/ingest_roads.py` | Deterministic projected geometry bound; preserve as source-cache index. |
| `max_x` | `REAL` | D | `flaskserver/ingest_buildings.py`; `flaskserver/ingest_roads.py` | Deterministic projected geometry bound; preserve as source-cache index. |
| `max_y` | `REAL` | D | `flaskserver/ingest_buildings.py`; `flaskserver/ingest_roads.py` | Deterministic projected geometry bound; preserve as source-cache index. |

Known `properties` member boundaries are also explicit because the physical
column is mixed:

| JSON member | SQLite type | Class | Initial writer | Meaning and purge treatment |
|---|---|---|---|---|
| `sourceProperties` | — | S | `flaskserver/ingest_buildings.py`; `flaskserver/ingest_roads.py` | Uninterpreted attributes from the retained Asiaq archive; preserve. |
| `ring` | — | D | `flaskserver/ingest_buildings.py` | Normalized/projected building geometry derived during import; preserve with source cache. |
| `path` | — | D | `flaskserver/ingest_roads.py` | Normalized/projected road/path geometry derived during import; preserve with source cache. |
| `groundZ` | — | D | `flaskserver/ingest_buildings.py` | Terrain-sampled building ground height; invalidate/resample when terrain changes. |
| `groundSampled` | — | D | `flaskserver/ingest_buildings.py` | Whether `groundZ` came from available terrain; reset as part of resampling workflow. |
| Other vehicle/user members | — | S | `flaskserver/vehicle_catalog.py`; `flaskserver/asset_catalog.py` | User-authored asset state; preserve. |

`purge_derived.py` currently does not modify `assets.db`. That is correct for
source geometry, source attributes, operator decisions, and user-authored
assets. It leaves the explicitly identified derived building-ground fields
stale after a terrain reset; correcting them requires a separate atomic
invalidation/resampling workflow rather than deleting source asset rows.

## Source material outside SQLite

- `flaskserver/gtk50_blocks/*.gpkg` are source vectors for `coastline_masks`.
- `flaskserver/grundkort/*_TekniskGrundkort_SHP.zip` are source archives for
  imported roads and buildings; `*.refresh.json` is download control and
  provenance.
- ArcticDEM/Copernicus COGs and imagery providers are remote origins. The
  payloads cached in `tiles.heightmap` and `textures.texture` are S because
  they let recovery proceed without contacting those origins again.
- Sounding source assets may be external, but the locally retained measurement
  columns are S and suffice for bathymetry rebuilds. `soundings.source_asset`
  and `source_sha256` are P: they retain identity and fingerprint, not bytes.

## Findings affecting `purge_derived.py`

1. The previous purge omitted all four `terrain_artifact_*` tables. On the
   audited live database it would delete 361 current `ancestor_crop` textures
   while leaving 732 derived revisions and their current pointers. Derived
   lineage should be removed without deleting provider lineage.
2. `classifier_annotations` must remain intact: each column participates in
   identifying or recording human training evidence.
3. The retained texture set contains hybrid negative-cache rows. The correct
   contract is “remove rebuildable data while retaining terminal coverage
   facts,” not “delete every derived byte.”
4. Generated texture lineage is incomplete: `textures.source` records a
   producer/state but not `input_tile_id`, the input revision time, or an input
   payload fingerprint. Current parent-change invalidation covers only
   `cooked_upscale`, so ancestor-crop fallbacks can become stale without being
   discoverable from the database.
5. `assets.z`, `assets.properties.groundZ`, and
   `assets.properties.groundSampled` are derived for `BYGNING` rows and remain
   outside the current purge boundary.
