
![Greenland terrain](greenland.png)

Hey! *purr* This project is a basic threejs Greenland terrain navigator / maybe future flight sim

The front end in /webserver folder is running vite. The entry point is `main.js` → `main.terrain.js`. The SPA uses a heatmap priority approach to determine what tiles/textures to load or drop, and uses [Takram three-geospatial](https://github.com/takram-design-engineering/three-geospatial) for atmosphere and cloud effects. There is a map view (no clouds) to help with navigation and tile debugging.

The backend in /flaskserver manages terrain heightmaps and textures in a SQLite db (terrain.db). It always assumes the user starts from scratch and will rebuild all missing data as needed. FIRST VISIT TO ANY LOCATION WILL BE SLOW — heightmaps and textures are fetched on demand and cached in the DB. Subsequent visits are fast. All tile demand is driven from the frontend heatmap.

## Data Sources

| Data | Source | Resolution | Notes |
|------|--------|-----------|-------|
| Heightmaps (primary) | [ArcticDEM v4.1](https://www.pgc.umn.edu/data/arcticdem/) mosaic via S3 | 10m | Cloud Optimized GeoTIFF, free, no auth |
| Heightmaps (fallback) | [Copernicus GLO-30](https://spacedata.copernicus.eu/) via S3 | 30m | Used when ArcticDEM has no coverage |
| Textures | [Dataforsyningen](https://dataforsyningen.dk/) WMS | 0.2m–1.6m | SPOT 6/7 + aerial ortho, requires free API token |
| Enhancement | SUPIR via [ComfyUI](https://github.com/comfyanonymous/ComfyUI) | — | Optional, upscales Dataforsyningen textures at depth 12+ |

## Coordinate Systems

| System | EPSG | Used For |
|--------|------|----------|
| NSIDC Polar Stereographic North | 3413 | Internal tile grid, DEM, all spatial queries (meters) |
| WGS84 Lat/Lon | 4326 | API input/output, camera positions, user-facing coords |
| Greenland Transverse Mercator | 3184 | Dataforsyningen WMS requests only |
| WGS84 Ellipsoid + ECEF | — | Three.js 3D rendering, camera, lighting, ENU frames |

**EPSG:3413** is the primary internal system. Everything else converts to/from it.

- `coords.py` handles `to_stereo(lat, lon)` (4326→3413) and `to_wgs84(x, y)` (3413→4326)
- Dataforsyningen textures: 3413 → 3184 for the WMS request, then warped back to 3413 (Lanczos)
- Client-side: lat/lon → `Geodetic` → ECEF for Three.js scene placement

## Texture Pipeline (DO NOT F*CK WITH THIS)

Textures follow a strict upgrade chain. Each stage only feeds the next. Do not skip stages or rewire the fallback order without understanding the full flow.

    dataforsyningen → dataforsyningen_enhanced → upscaled

1. **Bootstrap**: On first run, the server seeds the tile grid as empty skeletons (no heightmaps, no textures). These define the quadtree structure up to the target depth.
2. **tex-worker** fetches from Dataforsyningen WMS (SPOT 6/7 1.6m, EPSG:3184) on demand. If it fails (rate limit, timeout, no coverage), the tile stays uncached and an ancestor texture is cropped and served as a placeholder until the next request retries.
3. Dataforsyningen WMS requires EPSG:3184 (not 3413). The fetch reprojects 3413→3184 for the request, then warps the result back to 3413 with Lanczos resampling.
4. **enhance** (SUPIR upscaler via ComfyUI) ONLY processes `dataforsyningen` tiles. It never fetches from the internet. The output is `dataforsyningen_enhanced`.
5. Upscaling (SUPIR) only kicks in at **depth 12 and above**. Lower LOD tiles don't need it — the base Dataforsyningen imagery is sharp enough at those scales.

## Default Camera

The camera starts facing north at Nuuk (64.18°N, 51.72°W). You can override this via URL params, e.g. `?lat=66.5&lon=-53.2`. Press **R** to reset the view if shit gets crazy (e.g. the world suddenly turns into a blue ball).

## Map Mode

Press **M** to toggle a 2D map view (no clouds/atmosphere) for navigation and tile debugging. Right-click on a tile to inspect its metadata and submit an enhance request to the SUPIR upscaler. (WIP — enhance-on-click is still being hooked up.)

In 3D mode, atmosphere sliders allow adjusting cloud density, coverage, and lighting parameters. (WIP — still working out some bugs.)

## Setup

### Prerequisites
- Python 3.13+ with pip
- Node.js 18+

### Backend (Flask)
```bash
cd flaskserver
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Create a `.env` file in `flaskserver/` with your API token:
```
DATAFORSYNINGEN_TOKEN=<your-token>
```

To get a free token: [create a user account](https://dataforsyningen.dk/) (click "Log ind" → "Opret Profil"), confirm via email, then log in and go to your profile → "Administrer token til webservice og API'er" to generate a token.

### Frontend (Vite)

The frontend depends on a local clone of the [Takram three-geospatial](https://github.com/takram-design-engineering/three-geospatial) monorepo for atmosphere and cloud effects. Vite aliases `@takram/*` imports to this local source.

```bash
cd webserver
git clone https://github.com/takram-design-engineering/three-geospatial.git
cd three-geospatial && git checkout ab3d1cf5 && cd ..
npm install
```

### Running
```bash
# Terminal 1 — backend (terrain DB)
./flaskserver/runFlaskServer

# Terminal 2 — frontend (snazzy 3d ux)
./webserver/runViteServer
```

Both scripts log output to their respective directories (`runFlaskServer.log`, `runViteServer.log`).

## Data Attribution

This project uses the following external data sources:

- **Satellite orthophotos**: Indeholder data fra Klimadatastyrelsen (formerly Styrelsen for Dataforsyning og Infrastruktur). Datasets: "Grønland Satellitfoto" (SPOT 6/7 1.6m regional orthophoto, 0.2m aerial orthophoto). Fetched on demand via [Dataforsyningen WMS](https://dataforsyningen.dk/). Data is free for both commercial and non-commercial use with attribution. [Terms of use](https://dataforsyningen.dk/vilkaar).
- **Heightmaps (primary)**: [ArcticDEM v4.1](https://www.pgc.umn.edu/data/arcticdem/) 10m mosaic, provided by the Polar Geospatial Center under NSF-OPP awards 1043681, 1559691, and 1542736. CC-BY-4.0, free for commercial use with attribution. Fetched on demand via S3. [Acknowledgement policy](https://www.pgc.umn.edu/guides/stereo-derived-elevation-models/pgc-dem-products-arcticdem-rema-and-earthdem/).
- **Heightmaps (fallback)**: [Copernicus GLO-30 DEM](https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model), provided by the European Space Agency. Free for commercial use with attribution. Fetched on demand via S3.
- **Atmosphere & clouds**: [three-geospatial](https://github.com/takram-design-engineering/three-geospatial) by Takram.