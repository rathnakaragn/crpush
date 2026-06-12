import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["src/worker/**/*.integration.test.ts"],
    setupFiles: ["src/worker/integration-setup.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.json" },
        miniflare: {
          d1Databases: ["DB"],
          bindings: { AUTH_PASSWORD: "test-password" },
        },
      },
    },
  },
});
