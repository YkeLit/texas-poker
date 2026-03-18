import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(() => ({
  plugins: [react(), tsconfigPaths()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    allowedHosts: getAllowedHosts(process.env),
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
}));

function getAllowedHosts(env: NodeJS.ProcessEnv): string[] {
  const hosts = new Set<string>();

  for (const value of (env.VITE_ALLOWED_HOSTS ?? "").split(",")) {
    const host = value.trim();
    if (host) {
      hosts.add(host);
    }
  }

  const publicOrigins = [env.VITE_SOCKET_ORIGIN, env.VITE_PUBLIC_ORIGIN];
  for (const origin of publicOrigins) {
    if (!origin) {
      continue;
    }
    try {
      hosts.add(new URL(origin).hostname);
    } catch {
      // Ignore malformed overrides and let Vite report the real problem later.
    }
  }

  return [...hosts];
}
