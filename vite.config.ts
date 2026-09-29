import { defineConfig } from 'vite';

// Served as a GitHub Pages project site: https://irreal.github.io/mobile-3d-game/
export default defineConfig({
  base: '/mobile-3d-game/',
  server: {
    port: 5173,
  },
  build: {
    target: 'es2022',
    // three.js alone is ~700 kB minified; don't warn about it.
    chunkSizeWarningLimit: 1000,
  },
});
