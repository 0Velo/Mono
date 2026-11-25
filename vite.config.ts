import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

/**
 * One identifier per build, baked into the bundle and published next to it as
 * `version.json`. A home-screen app that iOS kept suspended keeps running old
 * JavaScript for days; comparing its own id with the deployed file is how it
 * learns that the person should reopen the app.
 */
function resolveBuildId(): string {
  const fromEnv = process.env.MONO_BUILD_ID?.trim()
  if (fromEnv) return fromEnv
  let sha = 'nogit'
  try {
    sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    // Building from an export without history still needs an id.
  }
  return `${sha}-${Date.now().toString(36)}`
}

const BUILD_ID = resolveBuildId()

export default defineConfig({
  // Relative base: GitHub Pages serves a project site at the repository name's
  // exact case (/Mono/ today). Relative asset URLs keep the same build working
  // at any path without a rebuild.
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [
    react(),
    {
      name: 'mono-build-id',
      apply: 'build',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: JSON.stringify({ build: BUILD_ID }),
        })
      },
    },
    nodePolyfills({
      include: ['buffer', 'crypto', 'stream', 'util', 'events', 'process', 'assert', 'os'],
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
  ],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  build: {
    target: 'es2020',
    cssCodeSplit: true,
    // The wallet screen legitimately ships web3.js; it is lazy, so the size
    // warning for that async chunk is noise.
    chunkSizeWarningLimit: 900,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        /**
         * Only the framework is pinned to a named chunk so the entry stays a
         * thin shell that paints instantly. Everything crypto-related is
         * reached exclusively through dynamic `import()`, so Rollup keeps it
         * in async chunks that the lock/onboarding screens never wait for.
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (
            id.includes('/react-dom/') ||
            id.includes('/react/') ||
            id.includes('/scheduler/') ||
            id.includes('react/jsx-runtime')
          ) {
            return 'react'
          }
          return undefined
        },
      },
    },
  },
})
