import http from 'node:http';
import path from 'node:path';
import { defineConfig } from 'vite';

const pkg = name => path.resolve(__dirname, 'three-geospatial/packages', name, 'src');

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
  const rejectRetiredPages = server => {
    server.middlewares.use((request, response, next) => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (pathname !== '/coverage.html') {
        next();
        return;
      }
      response.statusCode = 404;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end('Not found');
    });
  };

  return {
    name: 'log-serve-url',
    configureServer(server) {
      rejectRetiredPages(server);
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
    configurePreviewServer: rejectRetiredPages,
  };
}

export default defineConfig({
  plugins: [logServeUrl()],
  build: {
    target: 'esnext'
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
    proxy: {
      '/api': {
        target: 'http://localhost:5180',
        agent: flaskProxyAgent,
        proxyTimeout: 30_000,
      },
    }
  }
});
