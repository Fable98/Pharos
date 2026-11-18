import pino from "pino";
import { config } from "./config";

export const logger = pino({
    level: config.NODE_ENV === "test" ? "silent" : "info",
    transport: config.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined,
    redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
    ],
});