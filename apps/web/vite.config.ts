import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_SERVER_ORIGIN ?? "http://127.0.0.1:3001",
        changeOrigin: true,
      },
      "/healthz": {
        target: process.env.VITE_SERVER_ORIGIN ?? "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
});
