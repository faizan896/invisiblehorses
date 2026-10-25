import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['cloudflare-test/**/*.test.ts'],maxWorkers:1,testTimeout:30000,hookTimeout:30000}});
