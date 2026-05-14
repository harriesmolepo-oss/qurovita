import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      DATABASE_URL: "postgresql://qurovita:qurovita_test@localhost:5434/qurovita_test",
      JWT_SECRET: "test-integration-secret",
      NODE_ENV: "test",
    },
    globalSetup: ["./test/globalSetup.ts"],
    // Run each test file in a separate worker so pool connections don't leak
    pool: "forks",
  },
});
