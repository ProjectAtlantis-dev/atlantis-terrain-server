import http from 'node:http';
import path from 'node:path';
import { defineConfig } from 'vite';

const pkg = name => path.resolve(__dirname, 'three-geospatial/packages', name, 'src');
const flaskProxyTarget = process.env.FLASK_PROXY_TARGET || 'http://localhost:5180';
const devServerPort = Number(process.env.VITE_PORT || 5173);

// Bound connections from the dev proxy to Flask. Browser-side aborts can
// otherwise leave hundreds of upstream sockets alive while terrain demand is
// rapidly rebuilt, eventually exhausting Flask's per-process file limit.
const flaskProxyAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 24,
  maxTotalSockets: 24,
  maxFreeSockets: 4,
  timeout: 15_000,
});

function logServeUrl() {
  return {
    name: 'log-serve-url',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        const address = server.httpServer?.address();
        if (address == null || typeof address === 'string') {
          return;
        }

        const protocol = server.config.server.https ? 'https' : 'http';
        const port = address.port;
        let host = address.address;
        if (host === '::' || host === '0.0.0.0') {
          host = 'localhost';
        } else if (host.includes(':')) {
          host = `[${host}]`;
        }

        console.log(`[vite] serving at ${protocol}://${host}:${port}/`);
      });
    },
  };
}

export default defineConfig({
  plugins: [logServeUrl()],
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        coverage: path.resolve(__dirname, 'coverage.html'),
      },
    },
  },
  resolve: {
    alias: [
      { find: '@takram/three-atmosphere', replacement: pkg('atmosphere') },
      { find: '@takram/three-clouds', replacement: pkg('clouds') },
      { find: '@takram/three-geospatial-effects', replacement: pkg('effects') },
      { find: '@takram/three-geospatial', replacement: pkg('core') }
    ]
  },
  server: {
    port: devServerPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: flaskProxyTarget,
        agent: flaskProxyAgent,
        proxyTimeout: 30_000,
      },
    }
  }
});
