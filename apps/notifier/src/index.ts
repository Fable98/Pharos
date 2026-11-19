import { config } from "./config";
import { pool } from "./db";
import { logger } from "./logger";
import { Notifier } from "./notifier";

logger.info(
  {
    allowPrivate: config.PROBE_ALLOW_PRIVATE,
    maxAttempts: config.NOTIFY_MAX_ATTEMPTS,
    baseDelayS: config.NOTIFY_BASE_DELAY_S,
    telegramConfigured: Boolean(config.TELEGRAM_BOT_TOKEN),
  },
  "starting notifier service"
);

const notifier = new Notifier(pool);
await notifier.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down notifier");

  try {
    await notifier.stop();
    logger.info("notifier stopped");

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
