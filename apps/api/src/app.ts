import { randomUUID } from "node:crypto";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { config } from "./config";
import { pool } from "./db";
import { errorHandler } from "./error";
import { logger } from "./logger";
import { authRouter } from "./modules/auth/routes";
import { monitorsRouter } from "./modules/monitors/routes";
import { channelsRouter } from "./modules/channels/routes";
import { incidentsRouter } from "./modules/incidents/routes";

export function buildApp() {
    const app = express();
    app.disable("x-powered-by");
    app.set("trust proxy", 1);

    app.use(
        pinoHttp({
            logger,
            genReqId: (req, res) => {
                const id = (req.headers["x-request-id"] as string) ?? randomUUID();
                res.setHeader("x-request-id", id);
                return id;
            },
        })
    );
    app.use(helmet());
    app.use(cors({ origin: config.CORS_ORIGIN, credentials: true }));
    app.use(express.json({ limit: "100kb" }));
    app.use(cookieParser());

    app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
    app.get("/readyz", async (_req, res) => {
        try {
            await pool.query("SELECT 1");
            res.json({ status: "ready" });
        } catch {
            res.status(503).json({ status: "unavailable" });
        }
    });

    app.use("/v1/auth", authRouter);
    app.use("/v1/monitors", monitorsRouter);
    app.use("/v1/alert-channels", channelsRouter);
    app.use("/v1/incidents", incidentsRouter);
    app.use((_req, res) => res.status(404).json({ error: { code: "not_found" } }));
    app.use(errorHandler);
    return app;
}