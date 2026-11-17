import { buildApp } from "./app";
import { config } from "./config";
import { pool } from "./db";
import { logger } from "./logger";

const server = buildApp().listen(config.PORT, () =>
    logger.info(`api listening on :${config.PORT}`)
);

async function shutdown(signal: string) {
    logger.info({ signal }, "shutting down");
    server.close(async () => {
        await pool.end();
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref(); // hard stop if something hangs
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));