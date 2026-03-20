import { buildApp } from "./app";
import { readConfig } from "./config";
import { log } from "./lib/logger";

try {
  const config = readConfig();
  const { app } = await buildApp({ config });

  await app.listen({
    host: config.host,
    port: config.port,
  });
  log("info", "Texas Poker server started", {
    host: config.host,
    port: config.port,
  });
} catch (error) {
  log("error", "Failed to start server", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
