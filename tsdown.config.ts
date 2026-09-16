import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { cli: "src/cli/main.ts", mcp: "src/mcp/main.ts" },
  format: "esm",
  platform: "node",
  target: "node22.18",
  outExtensions: () => ({ js: ".mjs" }),
  sourcemap: true,
  dts: false,
  clean: true,
  deps: { neverBundle: true },
});
