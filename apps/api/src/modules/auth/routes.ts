import { Router, type Response } from "express";
import { loginSchema, registerSchema } from "@pharos/shared";
import { config } from "../../config";
import { HttpError } from "../../error";
import * as auth from "./service";

export const authRouter = Router();

const COOKIE = "refresh_token";
const setCookie = (res: Response, token: string) =>
    res.cookie(COOKIE, token, {
        httpOnly: true,
        secure: config.NODE_ENV === "production",
        sameSite: "lax",
        path: "/v1/auth",
        maxAge: 30 * 24 * 60 * 60 * 1000,
    });

authRouter.post("/register", async (req, res) => {
    const { email, password } = registerSchema.parse(req.body);
    const s = await auth.register(email, password);
    setCookie(res, s.refreshToken);
    res.status(201).json({ accessToken: s.accessToken });
});

authRouter.post("/login", async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const s = await auth.login(email, password);
    setCookie(res, s.refreshToken);
    res.json({ accessToken: s.accessToken });
});

authRouter.post("/refresh", async (req, res) => {
    const token = req.cookies?.[COOKIE];
    if (!token) throw new HttpError(401, "invalid_refresh_token");
    const s = await auth.refresh(token);
    setCookie(res, s.refreshToken);
    res.json({ accessToken: s.accessToken });
});

authRouter.post("/logout", async (req, res) => {
    const token = req.cookies?.[COOKIE];
    if (token) await auth.logout(token);
    res.clearCookie(COOKIE, { path: "/v1/auth" });
    res.status(204).end();
});