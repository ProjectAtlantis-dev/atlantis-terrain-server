import path from 'node:path';
import { defineConfig } from 'vite';

const pkg = name => path.resolve(__dirname, 'three-geospatial/packages', name, 'src');

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
    }
  };
}

export default defineConfig({
  plugins: [logServeUrl()],
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        webgpu: path.resolve(__dirname, 'webgpu.html')
      }
    }
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
    // Listen on all interfaces (IPv4 + IPv6): needed for tailnet access —
    // both `tailscale serve` (which dials 127.0.0.1) and direct
    // http://<tailscale-ip>:5173. Default binding was IPv6 loopback only.
    host: true,
    // Allow the tailscale-serve HTTPS hostname through vite's Host check.
    allowedHosts: ['.ts.net'],
    proxy: {
      '/api': 'http://localhost:5180'
    }
  }
});
