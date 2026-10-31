import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Web code consumes the shared contracts from source (same alias as apps/web/vite.config.ts).
    alias: { '@voxstudio/contracts': path.resolve(__dirname, 'packages/contracts/src/index.ts') },
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/api/test/**/*.test.ts',
      'apps/worker/test/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
    ],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // API + worker integration tests share one test database.
    fileParallelism: false,
    pool: 'forks',
  },
});
