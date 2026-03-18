export interface AppConfig {
  host: string;
  port: number;
  clientOrigin: string;
  tokenSecret: string;
  databaseUrl?: string;
  redisUrl?: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? 3001),
    clientOrigin: env.CLIENT_ORIGIN ?? "http://127.0.0.1:5173",
    tokenSecret: env.TOKEN_SECRET ?? "development-token-secret",
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
  };
}
