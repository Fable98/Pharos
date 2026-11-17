import { Router } from "express";
import { z } from "zod";
import { createMonitorSchema, updateMonitorSchema } from "@pharos/shared";
import { pool } from "../../db";
import { HttpError } from "../../errors";
import { requireAuth } from "../../middleware/auth";

const MAX_MONITORS = 50;
const COLS = `id, workspace_id AS "workspaceId", type, name, url, method,
  interval_s AS "intervalS", timeout_ms AS "timeoutMs",
  expected_status AS "expectedStatus", keyword, paused, created_at AS "createdAt"`;
const idParam = z.string().uuid();

export const monitorsRouter = Router();
monitorsRouter.use(requireAuth);

monitorsRouter.get("/", async (req, res) => {
    const { rows } = await pool.query(
        `SELECT ${COLS} FROM monitors WHERE workspace_id = $1 ORDER BY created_at DESC`,
        [req.auth!.workspaceId]
    );
    res.json({ data: rows });
});

monitorsRouter.post("/", async (req, res) => {
    const m = createMonitorSchema.parse(req.body);
    const wid = req.auth!.workspaceId;
    const count = await pool.query(`SELECT count(*)::int AS n FROM monitors WHERE workspace_id = $1`, [wid]);
    if (count.rows[0].n >= MAX_MONITORS) throw new HttpError(403, "monitor_limit_reached");
    const { rows } = await pool.query(
        `INSERT INTO monitors (workspace_id, name, url, method, interval_s, timeout_ms, expected_status, keyword)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLS}`,
        [wid, m.name, m.url, m.method, m.intervalS, m.timeoutMs, m.expectedStatus, m.keyword ?? null]
    );
    res.status(201).json(rows[0]);
});

monitorsRouter.get("/:id", async (req, res) => {
    const id = idParam.parse(req.params.id);
    const { rows } = await pool.query(
        `SELECT ${COLS} FROM monitors WHERE id = $1 AND workspace_id = $2`,
        [id, req.auth!.workspaceId]
    );
    if (!rows[0]) throw new HttpError(404, "not_found");
    res.json(rows[0]);
});

monitorsRouter.patch("/:id", async (req, res) => {
    const id = idParam.parse(req.params.id);
    const m = updateMonitorSchema.parse(req.body);
    const { rows } = await pool.query(
        `UPDATE monitors SET
       name = COALESCE($3, name), url = COALESCE($4, url), method = COALESCE($5, method),
       interval_s = COALESCE($6, interval_s), timeout_ms = COALESCE($7, timeout_ms),
       expected_status = COALESCE($8, expected_status), keyword = COALESCE($9, keyword),
       updated_at = now()
     WHERE id = $1 AND workspace_id = $2 RETURNING ${COLS}`,
        [id, req.auth!.workspaceId, m.name, m.url, m.method, m.intervalS, m.timeoutMs, m.expectedStatus, m.keyword]
    );
    if (!rows[0]) throw new HttpError(404, "not_found");
    res.json(rows[0]);
});

monitorsRouter.delete("/:id", async (req, res) => {
    const id = idParam.parse(req.params.id);
    const r = await pool.query(`DELETE FROM monitors WHERE id = $1 AND workspace_id = $2`, [id, req.auth!.workspaceId]);
    if (r.rowCount === 0) throw new HttpError(404, "not_found");
    res.status(204).end();
});

async function setPaused(id: string, workspaceId: string, paused: boolean) {
    const { rows } = await pool.query(
        `UPDATE monitors SET paused = $3, updated_at = now() WHERE id = $1 AND workspace_id = $2 RETURNING ${COLS}`,
        [id, workspaceId, paused]
    );
    if (!rows[0]) throw new HttpError(404, "not_found");
    return rows[0];
}
monitorsRouter.post("/:id/pause", async (req, res) =>
    res.json(await setPaused(idParam.parse(req.params.id), req.auth!.workspaceId, true)));
monitorsRouter.post("/:id/resume", async (req, res) =>
    res.json(await setPaused(idParam.parse(req.params.id), req.auth!.workspaceId, false)));