# Atlantis R3F

React Three Fiber port of the Atlantis Terrain Server frontend.

## Prerequisites

- Node.js 18+
- Flask terrain server running on port 5180 (`flaskserver/serve_flask.py`)
- Asset server running on port 8787 (`assetserver/`)

## Setup

```bash
cd r3f2

# Install dependencies
npm install

# Clone three-geospatial (required for atmosphere/clouds)
git clone https://github.com/takram-design-engineering/three-geospatial.git

# Start dev server
npm run dev
```

The app runs at http://localhost:5174

## Dependencies

### three-geospatial

The `@takram/three-atmosphere`, `@takram/three-clouds`, `@takram/three-geospatial`, and `@takram/three-geospatial-effects` packages are resolved via Vite aliases to a local clone of [three-geospatial](https://github.com/takram-design-engineering/three-geospatial). The clone must be at `r3f2/three-geospatial/`.

### Backend Services

| Service | Port | Purpose |
|---------|------|---------|
| Flask server | 5180 | Terrain tiles, textures, heightmaps |
| Asset server | 8787 | Vehicle definitions, structure instances, vehicle state persistence |

API calls to `/api/*` are proxied to Flask via Vite dev server config.
Asset server URL is configurable via `?assetServer=http://host:port` query param (defaults to `http://127.0.0.1:8787`).

## Controls

| Key | Action |
|-----|--------|
| WASD / Arrows | Move (flight) / Drive+Steer (vehicle) |
| Q / Z | Altitude up/down (flight) |
| Mouse drag | Look around |
| Scroll wheel | Zoom FOV / vehicle camera distance / map zoom |
| M | Toggle map mode |
| G | Toggle Google Maps panel |
| H | Toggle HUD |
| R | Reset view |
| Right-click | Enter vehicle (click on vehicle mesh) |
| Esc | Exit turret / exit vehicle |
| T | Toggle turret control (while in vehicle) |
| V | Cycle camera mode (while in vehicle) |
| LMB | Fire .50 cal (while in turret mode) |

## Architecture

```
src/
├── main.tsx                 Entry point
├── App.tsx                  Canvas + overlay layout
├── components/
│   ├── AtmosphereEffects    EffectComposer: clouds, aerial perspective, tone mapping
│   ├── CameraController     Free-flight, vehicle follow, turret follow cameras
│   ├── Crosshair            SVG turret crosshair overlay
│   ├── FireSystem            Tracer pool, impact pool, muzzle flash
│   ├── GameClockHUD          Game clock with transport controls
│   ├── GoogleMapsPanel       Draggable maps panel (Satellite/Map/Navigate)
│   ├── HUD                   Speed, heading, coordinates, mode display
│   ├── InputHandler          Keyboard, mouse, wheel, pointer lock
│   ├── MapModeRenderer       Orthographic map view with markers
│   ├── StructuresLayer       House/building placement and terrain snap
│   ├── TerrainManager        Tile streaming from Flask server
│   ├── TerrainRoot           ENU-anchored scene root
│   ├── TuningPanel           Atmosphere/cloud tuning sliders
│   ├── VehicleSystem         Vehicle loading, physics, suspension, turret pivots
│   └── WaterPlane            Custom shader ocean surface
├── hooks/
│   ├── useAssetServer        Fetch vehicle/structure definitions
│   ├── useClientLog          Batch client logging
│   ├── useDieselAudio        Engine audio (THREE.Audio + mp3)
│   └── useVehicleSave        Throttled vehicle state persistence
├── stores/                   Zustand state (controls, terrain, vehicle, UI, game clock)
├── types/                    TypeScript interfaces
└── utils/                    Constants, geodesy, terrain mesh building, procedural audio
```

## URL Parameters

| Param | Default | Description |
|-------|---------|-------------|
| `lat` | 64.1835 | Starting latitude |
| `lon` | -51.7216 | Starting longitude |
| `assetServer` | http://127.0.0.1:8787 | Asset server base URL |
| `vehicleDriveSpeed` | 24 | Max vehicle speed (m/s) |
| `minFlightAlt` | 2 | Minimum flight altitude (m) |
| `clientLog` | 1 | Enable client logging (0 to disable) |

See `src/utils/constants.ts` for the full list of configurable parameters.
