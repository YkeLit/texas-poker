import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  target: "es2022",
  external: ["@prisma/client"],
  noExternal: ["@texas-poker/shared", "@texas-poker/poker-engine"],
});
