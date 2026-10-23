import { defineConfig } from 'vitest/config';

// The Worker uses only web APIs (fetch, WebCrypto), all of which Node provides, so its tests run in plain Node.
export default defineConfig({ test: { environment: 'node', include: ['test/**/*.test.ts'] } });
