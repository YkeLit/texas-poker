import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  target: "es2022",
  noExternal: ["@texas-poker/shared", "@texas-poker/poker-engine"],
});
