import { createRedis, ensureResultsGroup } from "@pharos/queue";
import { config } from "./config";
import { pool } from "./db";
import { AlertEngine } from "./engine";
import { logger } from "./logger";

logger.info("starting alert-engine service");

const redis = createRedis(config.REDIS_URL, "alert-engine");
const reader = createRedis(config.REDIS_URL, "alert-engine-reader");

await ensureResultsGroup(redis);

const engine = new AlertEngine(redis, reader, pool);
await engine.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down alert-engine");

  try {
    await engine.stop();
    logger.info("alert engine stopped");

    await reader.disconnect();
    await redis.quit();
    logger.info("redis disconnected");

    await pool.end();
    logger.info("db pool closed");
  } catch (err) {
    logger.error({ err }, "error during shutdown");
    process.exit(1);
  }

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
