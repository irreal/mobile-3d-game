import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

function commitHash(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

// Served as a GitHub Pages project site: https://irreal.github.io/mobile-3d-game/
export default defineConfig({
  base: '/mobile-3d-game/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(commitHash()),
  },
  server: {
    port: 5173,
  },
  build: {
    target: 'es2022',
    // three.js alone is ~700 kB minified; don't warn about it.
    chunkSizeWarningLimit: 1000,
  },
});
