# Atlantis Terrain

![Greenland terrain](greenland.png)

Atlantis Terrain is a future collaborative builder for Greenland: a shared 3D environment where people can understand the land, develop ideas, and build together. Today it provides the terrain foundation, streaming elevation, imagery, coastlines, buildings, and roads into a globe-scale Three.js world with atmosphere, clouds, lighting, and water. The atmosphere and cloud effects use [Takram's three-geospatial](https://github.com/takram-design-engineering/three-geospatial).

> **First run is slow.** The tile database is not included in the repository. Terrain and imagery are fetched, processed, and cached as you explore, so new areas may take time to appear. Once those tiles have been built in the local SQLite database, later visits are much faster.

The project is built for local development and is still evolving. Generated databases, downloaded source data, and credentials are deliberately not committed.

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
