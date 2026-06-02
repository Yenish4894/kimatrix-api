import type { ConnectionOptions } from "bullmq";
import { config } from "@/config/index";

export const redisConfig: ConnectionOptions = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times: number) => Math.min(times * 50, 2000),
};
