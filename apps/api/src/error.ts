import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
    constructor(public status: number, public code: string) {
        super(code);
    }
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof ZodError) {
        res.status(400).json({
            error: {
                code: "validation_error",
                details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
                requestId: req.id,
            },
        });
        return;
    }
    if (err instanceof HttpError) {
        res.status(err.status).json({ error: { code: err.code, requestId: req.id } });
        return;
    }
    req.log.error({ err }, "unhandled error");
    res.status(500).json({ error: { code: "internal_error", requestId: req.id } });
};