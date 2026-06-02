import Redis from "ioredis";
import { config } from "@/config/index";
import { logger } from "@/utils/logger";

let client: Redis | null = null;

export function getRedisClient(): Redis {
  if (client) return client;

  client = new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD || undefined,
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 100, 2000),
  });

  client.on("error", (err) => {
    logger.error({ err }, "Redis connection error");
  });
  client.on("connect", () => {
    logger.info({ host: config.REDIS_HOST, port: config.REDIS_PORT }, "Redis connected");
  });

  return client;
}

export async function pingRedis(): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const pong = await redis.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
