import Redis from "ioredis";

export function createRedisClient(redisUrl?: string): Redis | null {
  if (!redisUrl) {
    return null;
  }

  return new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
}
