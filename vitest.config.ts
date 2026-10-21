import { defineConfig } from 'vitest/config';
import { sourceAliases } from './vite.config';

export default defineConfig({
  resolve: { alias: sourceAliases },
  test: {
    include: ['apps/workbench/server/**/*.test.ts', 'apps/workbench/shared/**/*.test.ts'],
    environment: 'node',
    maxWorkers: 1,
    testTimeout: 20_000,
  },
});
