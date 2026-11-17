import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "./config";

export const signAccessToken = (userId: string, workspaceId: string) =>
    jwt.sign({ sub: userId, wid: workspaceId }, config.JWT_SECRET, { expiresIn: "15m" });

export const verifyAccessToken = (token: string) =>
    jwt.verify(token, config.JWT_SECRET) as jwt.JwtPayload;

// Refresh tokens are random strings; only their SHA-256 hash is stored.
export const newRefreshToken = () => crypto.randomBytes(32).toString("base64url");
export const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");