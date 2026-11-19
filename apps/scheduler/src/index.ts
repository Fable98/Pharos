import { createRedis, claimDue, reconcileSchedule } from "@pharos/queue";
import { config } from "./config";
import { pool } from "./db";
import { logger } from "./logger";

logger.info("starting scheduler");
const redis = createRedis(config.REDIS_URL, "scheduler");

let shuttingDown = false;
let inFlightClaim = false;
let claimedTotal = 0;

async function syncMonitors(): Promise<void> {
  if (shuttingDown) return;
  try {
    const { rows } = await pool.query<{ id: string; intervalS: number }>(
      `SELECT id, interval_s AS "intervalS" FROM monitors WHERE type = 'http' AND url IS NOT NULL AND NOT paused`
    );
    const { added, removed } = await reconcileSchedule(redis, rows);
    if (added > 0 || removed > 0) {
      logger.info({ added, removed, active: rows.length }, "reconciled monitor schedule");
    }
  } catch (err) {
    logger.error({ err }, "failed to reconcile monitor schedule");
  }
}

async function claimLoop(): Promise<void> {
  if (shuttingDown || inFlightClaim) return;
  inFlightClaim = true;
  try {
    let claimed = 0;
    do {
      claimed = await claimDue(redis, Date.now(), 1000);
      claimedTotal += claimed;
    } while (claimed === 1000 && !shuttingDown);
  } catch (err) {
    logger.error({ err }, "error claiming due monitors");
  } finally {
    inFlightClaim = false;
  }
}

function heartbeat(): void {
  if (shuttingDown) return;
  logger.info({ claimedTotal }, "scheduler heartbeat");
}

await syncMonitors();
await claimLoop();

const syncTimer = setInterval(syncMonitors, 10_000);
const claimTimer = setInterval(claimLoop, 500);
const heartbeatTimer = setInterval(heartbeat, 10_000);

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down scheduler");

  clearInterval(syncTimer);
  clearInterval(claimTimer);
  clearInterval(heartbeatTimer);

  const start = Date.now();
  while (inFlightClaim && Date.now() - start < 10_000) {
    await new Promise((r) => setTimeout(r, 50));
  }

  try {
    await redis.quit();
    logger.info("redis connection closed");
    await pool.end();
    logger.info("db pool closed");
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "error during scheduler shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
