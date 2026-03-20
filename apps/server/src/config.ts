export interface AppConfig {
  host: string;
  port: number;
  clientOrigin: string | string[];
  tokenSecret: string;
  databaseUrl?: string;
  redisUrl?: string;
}

const DEFAULT_CLIENT_ORIGIN = "http://127.0.0.1:5173";

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const tokenSecret = env.TOKEN_SECRET?.trim();
  if (!tokenSecret) {
    throw new Error("TOKEN_SECRET is required");
  }

  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? 3001),
    clientOrigin: parseClientOrigins(env.CLIENT_ORIGIN),
    tokenSecret,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
  };
}

export function parseClientOrigins(value?: string): string[] {
  const parsed = (value ?? DEFAULT_CLIENT_ORIGIN)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : [DEFAULT_CLIENT_ORIGIN];
}

export function normalizeClientOrigins(value: string | string[]): string[] {
  if (Array.isArray(value)) {
    return value.map((origin) => origin.trim()).filter(Boolean);
  }

  return parseClientOrigins(value);
}
