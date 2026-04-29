import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/websocket-transport.spec.ts"],
  },
});
