import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import type { PoolClient } from "pg";
import { pool, tx } from "../../db";
import { HttpError } from "../../error";
import { hashToken, newRefreshToken, signAccessToken } from "../../tokens";

export type Session = { accessToken: string; refreshToken: string };

async function issueSession(
    c: PoolClient,
    userId: string,
    workspaceId: string,
    familyId: string = randomUUID()
): Promise<Session> {
    const refreshToken = newRefreshToken();
    await c.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
     VALUES ($1, $2, $3, now() + interval '30 days')`,
        [userId, hashToken(refreshToken), familyId]
    );
    return { accessToken: signAccessToken(userId, workspaceId), refreshToken };
}

export async function register(email: string, password: string): Promise<Session> {
    const passwordHash = await argon2.hash(password); // argon2id by default
    const base = email.split("@")[0].replace(/[^a-z0-9]/g, "") || "team";
    const slug = `${base}-${randomUUID().slice(0, 4)}`;
    return tx(async (c) => {
        const u = await c.query(
            `INSERT INTO users (email, password_hash) VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING RETURNING id`,
            [email, passwordHash]
        );
        if (!u.rows[0]) throw new HttpError(409, "email_taken");
        const w = await c.query(
            `INSERT INTO workspaces (owner_id, name, slug) VALUES ($1, $2, $3) RETURNING id`,
            [u.rows[0].id, "My workspace", slug]
        );
        return issueSession(c, u.rows[0].id, w.rows[0].id);
    });
}

export async function login(email: string, password: string): Promise<Session> {
    const { rows } = await pool.query(
        `SELECT u.id, u.password_hash, w.id AS workspace_id
     FROM users u JOIN workspaces w ON w.owner_id = u.id
     WHERE u.email = $1 LIMIT 1`,
        [email]
    );
    const user = rows[0];
    if (!user || !(await argon2.verify(user.password_hash, password))) {
        throw new HttpError(401, "invalid_credentials");
    }
    return tx((c) => issueSession(c, user.id, user.workspace_id));
}

export async function refresh(token: string): Promise<Session> {
    const session = await tx(async (c) => {
        const { rows } = await c.query(
            `SELECT t.id, t.user_id, t.family_id, t.expires_at, t.revoked_at, w.id AS workspace_id
       FROM refresh_tokens t JOIN workspaces w ON w.owner_id = t.user_id
       WHERE t.token_hash = $1 FOR UPDATE OF t`,
            [hashToken(token)]
        );
        const row = rows[0];
        if (!row) return null;
        if (row.revoked_at) {
            // A rotated token was presented again: assume theft and kill the family.
            await c.query(
                `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
                [row.family_id]
            );
            return null; // returned (not thrown) so the revocation commits
        }
        if (new Date(row.expires_at) < new Date()) return null;
        await c.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [row.id]);
        return issueSession(c, row.user_id, row.workspace_id, row.family_id);
    });
    if (!session) throw new HttpError(401, "invalid_refresh_token");
    return session;
}

export async function logout(token: string): Promise<void> {
    await pool.query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
        [hashToken(token)]
    );
}