import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/flags/**/*.test.ts'],
    environment: 'node',
  },
});
