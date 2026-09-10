# Atlantis terrain viewer

Requires Git, Bash, and Node.js 22+ with npm, plus internet access for setup.

After cloning this repository, run from its root:

```bash
./runViteServer
```

The script installs the exact npm lockfile dependencies, fetches the pinned
Takram source checkout when absent, then starts Vite at http://localhost:5173.
It works from any working directory. Each launch runs `npm ci`; for subsequent
launches without reinstalling dependencies, use `npm run dev`.

For installation without starting Vite:

```bash
./setup
npm run build
npm test
```

Takram is pinned to `ab3d1cf54cfe2bd3d79ffd2ee872d801050b6c64` (2025-12-24).
Vite imports its source through aliases, so the published Takram versions in
package.json are not the source versions used by the browser. Setup skips Git
LFS asset downloads and fetches only the pinned commit's shallow history.
Existing checkouts at another revision are rejected rather than overwritten;
local edits in a checkout at the pinned revision are preserved.

Setup also checks the compatibility of Atlantis's runtime cloud shader patch.
The WebGL workarounds are tracked in this repository and retained on every
clone; see [Takram integration notes](takram.md). Setup never upgrades Takram
to the latest upstream release.

## Backend and runtime assets

The viewer requires a compatible terrain API. By default Vite proxies `/api`
to http://localhost:5180. The `/api/assets` catalog is required at startup;
terrain, textures, and other features also use this backend. Setup installs
the frontend only; it does not install or start the backend.

With the MCP Terrain backend, start the viewer HTTP server using Terrain's
`Server.start()`. `Asset.start()` manages the asset DB independently and does
not open the HTTP port. Even `/api/assets` goes through the terrain HTTP server.
If Vite reports `terrain_server_unreachable`, check `Server.status()` and start
the Terrain server, or set `FLASK_PROXY_TARGET` if it uses a different address.

```bash
FLASK_PROXY_TARGET=http://127.0.0.1:5180 VITE_PORT=5174 ./runViteServer
```

The active renderer is WebGL. Atmosphere lookup textures are downloaded from
GitHub at runtime and cached in the browser; Font Awesome comes from cdnjs.
Keep the tracked `public/` models, audio, and textures in the repository.
Production static hosting must route `/api` to the backend and serve the viewer
at the origin root. The optional client log page also expects WebSocket port 5181.

## Repository contents

Commit the source, package.json, package-lock.json, scripts, and public assets.
The local .gitignore excludes dependencies, generated output, and the recreated
Takram checkout. A fresh clone followed by `./runViteServer` restores them.
