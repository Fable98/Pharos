import { Router } from "express";
import { z } from "zod";
import { createMonitorSchema, updateMonitorSchema } from "@pharos/shared";
import { pool } from "../../db";
import { HttpError } from "../../error";
import { requireAuth } from "../../middleware/auth";

const MAX_MONITORS = 50;
const COLS = `id, workspace_id AS "workspaceId", type, name, url, method,
  interval_s AS "intervalS", timeout_ms AS "timeoutMs",
  expected_status AS "expectedStatus", keyword, paused, created_at AS "createdAt"`;
const idParam = z.string().uuid();

const isoDateSchema = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"));

const resultsQuerySchema = z.object({
  from: z.preprocess(
    (val) => (val === "" || val === null ? undefined : val),
    isoDateSchema.optional()
  ),
  to: z.preprocess(
    (val) => (val === "" || val === null ? undefined : val),
    isoDateSchema.optional()
  ),
  limit: z.preprocess(
    (val) => (val === "" || val === null ? undefined : val),
    z.coerce.number().int().min(1).max(1000).default(100)
  ),
});

const uptimeQuerySchema = z.object({
  range: z.preprocess(
    (val) => (val === "" || val === null ? undefined : val),
    z.enum(["1h", "24h", "7d"]).default("24h")
  ),
});

const seriesQuerySchema = z.object({
  from: z.preprocess(
    (val) => (val === "" || val === null ? undefined : val),
    isoDateSchema.optional()
  ),
  to: z.preprocess(
    (val) => (val === "" || val === null ? undefined : val),
    isoDateSchema.optional()
  ),
});

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

monitorsRouter.get("/:id/results", async (req, res) => {
    const id = idParam.parse(req.params.id);
    const q = resultsQuerySchema.parse(req.query);

    const monitor = await pool.query(
        `SELECT id FROM monitors WHERE id = $1 AND workspace_id = $2`,
        [id, req.auth!.workspaceId]
    );
    if (!monitor.rows[0]) throw new HttpError(404, "not_found");

    const toDate = q.to ? new Date(q.to) : new Date();
    const fromDate = q.from
        ? new Date(q.from)
        : new Date(toDate.getTime() - 24 * 60 * 60 * 1000);

    const { rows } = await pool.query(
        `SELECT
           time,
           ok,
           status_code AS "statusCode",
           latency_ms AS "latencyMs",
           dns_ms AS "dnsMs",
           tcp_ms AS "tcpMs",
           tls_ms AS "tlsMs",
           ttfb_ms AS "ttfbMs",
           error_code AS "errorCode"
         FROM check_results
         WHERE monitor_id = $1 AND time >= $2 AND time <= $3
         ORDER BY time DESC
         LIMIT $4`,
        [id, fromDate, toDate, q.limit]
    );

    res.json({ data: rows });
});

monitorsRouter.get("/:id/uptime", async (req, res) => {
    const id = idParam.parse(req.params.id);
    const q = uptimeQuerySchema.parse(req.query);

    const monitor = await pool.query(
        `SELECT id FROM monitors WHERE id = $1 AND workspace_id = $2`,
        [id, req.auth!.workspaceId]
    );
    if (!monitor.rows[0]) throw new HttpError(404, "not_found");

    const intervalMap: Record<string, string> = {
        "1h": "1 hour",
        "24h": "24 hours",
        "7d": "7 days",
    };

    const { rows } = await pool.query(
        `SELECT
           count(*)::int AS checks,
           count(*) FILTER (WHERE ok = true)::int AS ok_checks,
           avg(latency_ms) FILTER (WHERE ok = true) AS avg_latency
         FROM check_results
         WHERE monitor_id = $1 AND time >= now() - $2::interval`,
        [id, intervalMap[q.range]]
    );

    const row = rows[0];
    const checks = row?.checks ?? 0;
    const okChecks = row?.ok_checks ?? 0;
    const uptimePct =
        checks > 0 ? Math.round(((okChecks / checks) * 100) * 100) / 100 : null;
    const avgLatencyMs =
        row?.avg_latency !== null && row?.avg_latency !== undefined
            ? Math.round(Number(row.avg_latency))
            : null;

    res.json({
        range: q.range,
        checks,
        uptimePct,
        avgLatencyMs,
    });
});

monitorsRouter.get("/:id/series", async (req, res) => {
    const id = idParam.parse(req.params.id);
    const q = seriesQuerySchema.parse(req.query);

    const monitor = await pool.query(
        `SELECT id FROM monitors WHERE id = $1 AND workspace_id = $2`,
        [id, req.auth!.workspaceId]
    );
    if (!monitor.rows[0]) throw new HttpError(404, "not_found");

    const toDate = q.to ? new Date(q.to) : new Date();
    const fromDate = q.from
        ? new Date(q.from)
        : new Date(toDate.getTime() - 3 * 60 * 60 * 1000);

    const diffMs = toDate.getTime() - fromDate.getTime();
    if (diffMs < 0 || diffMs > 24 * 60 * 60 * 1000) {
        throw new HttpError(400, "range_too_large");
    }

    const { rows } = await pool.query(
        `SELECT
           bucket,
           sum(checks)::int AS checks,
           sum(failures)::int AS failures,
           round(sum(latency_sum)::numeric / NULLIF(sum(latency_n), 0))::int AS "avgLatencyMs",
           max(max_latency_ms) AS "maxLatencyMs"
         FROM check_stats_1m
         WHERE monitor_id = $1 AND bucket >= $2 AND bucket <= $3
         GROUP BY bucket
         ORDER BY bucket ASC`,
        [id, fromDate, toDate]
    );

    res.json({ data: rows });
});