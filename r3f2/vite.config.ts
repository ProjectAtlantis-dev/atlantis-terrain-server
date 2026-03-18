import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = (name: string) =>
  path.resolve(__dirname, 'three-geospatial/packages', name, 'src');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@takram/three-atmosphere', replacement: pkg('atmosphere') },
      { find: '@takram/three-clouds', replacement: pkg('clouds') },
      { find: '@takram/three-geospatial-effects', replacement: pkg('effects') },
      { find: '@takram/three-geospatial', replacement: pkg('core') },
      { find: '@/', replacement: path.resolve(__dirname, 'src') + '/' },
    ],
  },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:5180',
    },
  },
});
