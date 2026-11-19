import { config } from "./config";
import { pool } from "./db";
import { logger } from "./logger";
import { ResultBuffer } from "./buffer";
import { ProbeLoop } from "./loop";

logger.info(
  { region: config.REGION, allowPrivate: config.PROBE_ALLOW_PRIVATE },
  "starting worker"
);

const buffer = new ResultBuffer(pool);
const loop = new ProbeLoop(pool, buffer);
await loop.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down worker");

  try {
    await loop.stop();
    logger.info("probe loop stopped");
    await buffer.stop();
    logger.info("result buffer flushed");
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
