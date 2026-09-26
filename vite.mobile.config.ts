import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Web build for the Capacitor/Android shell. Same renderer sources as the
 * desktop app; only the entry point and the platform bridge differ.
 */

/** The default persona, memory and catalog the app copies out on first run. */
const BUNDLED_DEFAULTS = ['default-persona.md', 'default-memory.md', 'model-catalog.json'];

function bundleDefaults(): Plugin {
  return {
    name: 'kitsune-bundle-defaults',
    generateBundle() {
      for (const name of BUNDLED_DEFAULTS) {
        this.emitFile({
          type: 'asset',
          fileName: `defaults/${name}`,
          source: readFileSync(resolve(__dirname, 'resources', name), 'utf8'),
        });
      }
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, 'src/mobile'),
  // Capacitor serves the bundle from the APK, so every URL must be relative.
  base: './',
  plugins: [react(), bundleDefaults()],
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  build: {
    outDir: resolve(__dirname, 'dist-mobile'),
    emptyOutDir: true,
    // A mid-range phone is the target, not a desktop GPU.
    target: 'es2022',
    rollupOptions: {
      input: { index: resolve(__dirname, 'src/mobile/index.html') },
      output: {
        // three.js dwarfs everything else; splitting it lets the WebView parse
        // the app shell without waiting on the whole 3D stack.
        manualChunks: {
          three: ['three', '@pixiv/three-vrm', '@pixiv/three-vrm-animation'],
        },
      },
    },
  },
});
