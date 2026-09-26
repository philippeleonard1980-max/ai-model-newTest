import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      // The units under test are pure, but they sit in modules that import
      // Electron for their file paths. A stub keeps them importable in Node.
      electron: resolve(__dirname, 'test/electron-stub.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
