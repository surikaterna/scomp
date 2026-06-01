import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/worker-entry.ts"],
  format: ["esm", "cjs"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
