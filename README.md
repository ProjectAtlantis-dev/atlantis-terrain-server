# Atlantis Terrain

![Greenland terrain](greenland.png)

Atlantis Terrain is a future collaborative builder for Greenland: a shared 3D threejs environment where people can explore and build together. The atmosphere and cloud effects use [Takram's three-geospatial](https://github.com/takram-design-engineering/three-geospatial).

> **First run is slow.** The various data sources are pulled from various government bodies (free but some registrations are required - see attributions section below) based on camera location, so new areas may take time to appear. Once data has been cached in the local Flask/SQLite database, later visits are much faster.

## Quick start

You will need:

- Python 3.13+
- Node.js 18+
- Git
- A free [Dataforsyningen](https://dataforsyningen.dk/) API token

Set up the backend:

```bash
cd flaskserver
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cd ..
```

Create `flaskserver/.env` with a token from your Dataforsyningen profile:

```dotenv
DATAFORSYNINGEN_TOKEN=your-token-here
```

GTK50 coastline downloads also use the account credentials when present:

```dotenv
DATAFORSYNINGEN_FTP_USER=your-account-email
DATAFORSYNINGEN_FTP_PASS=your-account-password
```

Set up the frontend and its pinned three-geospatial source checkout:

```bash
cd webserver
git clone https://github.com/takram-design-engineering/three-geospatial.git
git -C three-geospatial checkout ab3d1cf5
npm install
cd ..
```

Run the backend and frontend in separate terminals from the repository root:

```bash
./flaskserver/runFlaskServer
```

```bash
./webserver/runViteServer
```

Open <http://localhost:5173/>. Vite proxies browser API requests to Flask on port 5180. The launch scripts write logs alongside themselves.

The first backend start creates `flaskserver/terrain.db`, seeds the terrain hierarchy, and begins downloading configured Asiaq settlement data in the background. Tile content continues to populate on demand as you move around the world.

## Bathymetry handoff

Underwater terrain is stored independently in `terrain.db.bathymetry`; it must
not overwrite `tiles.heightmap`. The normal producer contract is one depth-8
row per covered tile:

- `tile_id` — existing `8-col-row` terrain tile
- `heightmap` — zlib-compressed, south-first `65 × 65` float32 elevations
- `water_px`, `min_z`, `max_z` — coverage and elevation summary metadata
- `source`, `version`, `updated_at` — provenance and revision metadata

The raster spans the corresponding tile's EPSG:3413 bounding box, including
shared edge samples. Use `NaN` for missing samples. At render time, valid
non-positive bathymetry inside the effective official-water mask overrides the
synthetic −5 m seabed. Missing or positive samples remain exactly −5 m,
land continues to use `tiles.heightmap`, and detailed terrain tiles
crop/resample their depth-8 bathymetry ancestor automatically.

When `~/work/glacier/runOnDemand` is present, flying close enough to load a
depth-12 coastline mask also queues its uncovered depth-8 fjord section.
Mixed land/water masks trigger directly; all-water tiles trigger only within
2 km of that coast. Glacier requests the remaining DEM/mask coverage through
Flask, solves a stable regional bed, writes depth 12, and derives depths 11–8.
This intentionally excludes offshore banks such as Fylla until a separate
bank model exists. Set `GLACIER_ROOT` if the Glacier checkout lives elsewhere.

The HUD's **bathymetry map** toggle displays cyan depth-12 mapped footprints,
yellow actual-bottom soundings, and orange lower-bound observations. It
refreshes while enabled, so newly completed coverage appears during flight.

## GPU profiling

Leave the WebGL terrain page open, then control its asynchronous GPU pass
profiler through Flask:

```bash
curl -X POST -H 'Content-Type: application/json' \
  --data '{"sampleInterval":5}' \
  http://127.0.0.1:5180/api/gpu-profile/start

curl http://127.0.0.1:5180/api/gpu-profile

curl -X POST http://127.0.0.1:5180/api/gpu-profile/stop

curl http://127.0.0.1:5180/api/gpu-profile
```

The browser polls Flask for commands. On stop it drains outstanding timer
queries and posts the pass summary back to the same status endpoint. The
profiler currently requires the WebGL backend and
`EXT_disjoint_timer_query_webgl2`.

## Repository map

- `webserver/` — the Vite/Three.js application and browser-side tests
- `flaskserver/` — terrain API, data acquisition, processing, and SQLite caches
- `assetserver/` — optional TypeScript management API for the shared asset catalog

The browser application talks only to Flask. Flask also reads and creates `assetserver/assets.db`, so the asset server is not required for normal use. To work on its editing/management API, run `npm install` in `assetserver/`, then start it with `./assetserver/runAssetServer`.

## Data and attribution

- Elevation comes primarily from [ArcticDEM](https://www.pgc.umn.edu/data/arcticdem/), with [Copernicus GLO-30](https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model) as fallback.
- Orthophotos come from Greenland satellite and aerial products served by [Dataforsyningen](https://dataforsyningen.dk/). Contains data from Klimadatastyrelsen; see its [terms of use](https://dataforsyningen.dk/vilkaar).
- Coastline masks use the Åbent Land Grønland 1:50,000 vector dataset from Klimadatastyrelsen.
- **Contains data from Asiaq, Greenland Survey:** buildings and roads are sourced from Asiaq's Teknisk Grundkort settlement maps, obtained through [Asiaq Kortforsyning](https://kortforsyning.asiaq.gl/). See [Asiaq's terms of use](https://www.asiaq.gl/wp-content/uploads/2026/04/EN_Terms_of_use_for_Asiaq_geodata.pdf).
- Atmosphere and clouds use [three-geospatial](https://github.com/takram-design-engineering/three-geospatial) by Takram.

Google satellite imagery is used only as an external debugging and classification reference; it is not distributed by this project.

## Why this exists

Greenland's scale, remoteness, and terrain demand new ways to collaborate on autonomous machinery, robotics, drones, infrastructure, and settlements. Atlantis Terrain aims to become the shared place where those possibilities can be explored and built together.
