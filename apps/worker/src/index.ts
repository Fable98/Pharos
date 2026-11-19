import { createRedis, ensureGroup, ackJobs, publishResults } from "@pharos/queue";
import { config } from "./config";
import { pool } from "./db";
import { logger } from "./logger";
import { ResultBuffer } from "./buffer";
import { MonitorCache } from "./monitors";
import { JobRunner } from "./runner";

logger.info(
  { region: config.REGION, allowPrivate: config.PROBE_ALLOW_PRIVATE },
  "starting worker"
);

const redis = createRedis(config.REDIS_URL, "worker");
const reader = createRedis(config.REDIS_URL, "worker-reader");

await ensureGroup(redis);

const buffer = new ResultBuffer(pool, async (rows) => {
  await publishResults(redis, rows);
  const streamIds = rows.map((r) => r.streamId).filter(Boolean);
  if (streamIds.length > 0) {
    await ackJobs(redis, streamIds);
  }
});

const monitorCache = new MonitorCache(pool);
await monitorCache.start();

const runner = new JobRunner(redis, reader, buffer, monitorCache);
await runner.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down worker");

  try {
    await runner.stop();
    logger.info("job runner stopped");
    await monitorCache.stop();
    logger.info("monitor cache stopped");
    await buffer.stop();
    logger.info("result buffer flushed and remaining jobs acked");
    reader.disconnect();
    logger.info("reader redis disconnected");
    await redis.quit();
    logger.info("commands redis closed");
    await pool.end();
    logger.info("db pool closed");
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "error during shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
