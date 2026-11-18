import type { RequestHandler } from "express";
import { HttpError } from "../error";
import { verifyAccessToken } from "../tokens";

export const requireAuth: RequestHandler = (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new HttpError(401, "unauthorized");
    let payload;
    try {
        payload = verifyAccessToken(header.slice(7));
    } catch {
        throw new HttpError(401, "unauthorized");
    }
    req.auth = { userId: payload.sub as string, workspaceId: payload["wid"] as string };
    next();
};