import { Router } from "express";
import { z } from "zod";
import { pool } from "../../db";
import { requireAuth } from "../../middleware/auth";

const querySchema = z.object({
  status: z.preprocess(
    (val) => (val === "" || val === null ? undefined : val),
    z.enum(["open", "resolved"]).optional()
  ),
  monitorId: z.preprocess(
    (val) => (val === "" || val === null ? undefined : val),
    z.string().uuid().optional()
  ),
  limit: z.preprocess(
    (val) => (val === "" || val === null ? undefined : val),
    z.coerce.number().int().min(1).max(100).default(50)
  ),
});

export const incidentsRouter = Router();
incidentsRouter.use(requireAuth);

incidentsRouter.get("/", async (req, res) => {
  const q = querySchema.parse(req.query);
  const wid = req.auth!.workspaceId;

  const conditions: string[] = ["m.workspace_id = $1"];
  const params: any[] = [wid];

  if (q.status === "open") {
    conditions.push("i.resolved_at IS NULL");
  } else if (q.status === "resolved") {
    conditions.push("i.resolved_at IS NOT NULL");
  }

  if (q.monitorId) {
    params.push(q.monitorId);
    conditions.push(`i.monitor_id = $${params.length}`);
  }

  params.push(q.limit);
  const limitIndex = params.length;

  const query = `
    SELECT
      i.id,
      i.monitor_id AS "monitorId",
      m.name AS "monitorName",
      i.started_at AS "startedAt",
      i.resolved_at AS "resolvedAt",
      i.cause,
      CASE
        WHEN i.resolved_at IS NOT NULL THEN
          ROUND(EXTRACT(EPOCH FROM (i.resolved_at - i.started_at)))::int
        ELSE NULL
      END AS "durationS"
    FROM incidents i
    JOIN monitors m ON m.id = i.monitor_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY i.started_at DESC
    LIMIT $${limitIndex}
  `;

  const { rows } = await pool.query(query, params);
  res.json({ data: rows });
});
