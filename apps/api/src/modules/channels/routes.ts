import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { createChannelSchema } from "@pharos/shared";
import { pool } from "../../db";
import { HttpError } from "../../error";
import { requireAuth } from "../../middleware/auth";

const idParam = z.string().uuid();
const MAX_CHANNELS = 10;

export const channelsRouter = Router();
channelsRouter.use(requireAuth);

channelsRouter.get("/", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, type, name, config, enabled, created_at AS "createdAt"
     FROM alert_channels
     WHERE workspace_id = $1
     ORDER BY created_at DESC`,
    [req.auth!.workspaceId]
  );

  const data = rows.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    target: r.type === "telegram" ? r.config?.chatId : r.config?.url,
    enabled: r.enabled,
    createdAt: r.createdAt,
  }));

  res.json({ data });
});

channelsRouter.post("/", async (req, res) => {
  const c = createChannelSchema.parse(req.body);
  const wid = req.auth!.workspaceId;

  const countRes = await pool.query(
    `SELECT count(*)::int AS n FROM alert_channels WHERE workspace_id = $1`,
    [wid]
  );
  if (countRes.rows[0].n >= MAX_CHANNELS) {
    throw new HttpError(403, "channel_limit_reached");
  }

  let secret: string | undefined;
  let config: Record<string, any> = {};

  if (c.type === "telegram") {
    config = { chatId: c.chatId };
  } else if (c.type === "webhook") {
    secret = crypto.randomBytes(24).toString("base64url");
    config = { url: c.url, secret };
  }

  const { rows } = await pool.query(
    `INSERT INTO alert_channels (workspace_id, type, name, config)
     VALUES ($1, $2, $3, $4)
     RETURNING id, type, name, config, enabled, created_at AS "createdAt"`,
    [wid, c.type, c.name, JSON.stringify(config)]
  );

  const created = rows[0];
  const responseData: Record<string, any> = {
    id: created.id,
    type: created.type,
    name: created.name,
    target: c.type === "telegram" ? c.chatId : c.url,
    enabled: created.enabled,
    createdAt: created.createdAt,
  };

  if (secret) {
    responseData.secret = secret;
  }

  res.status(201).json(responseData);
});

channelsRouter.delete("/:id", async (req, res) => {
  const id = idParam.parse(req.params.id);
  const r = await pool.query(
    `DELETE FROM alert_channels WHERE id = $1 AND workspace_id = $2`,
    [id, req.auth!.workspaceId]
  );
  if (r.rowCount === 0) throw new HttpError(404, "not_found");
  res.status(204).end();
});

channelsRouter.post("/:id/test", async (req, res) => {
  const id = idParam.parse(req.params.id);
  const chRes = await pool.query(
    `SELECT id FROM alert_channels WHERE id = $1 AND workspace_id = $2`,
    [id, req.auth!.workspaceId]
  );
  if (!chRes.rows[0]) throw new HttpError(404, "not_found");

  const dedupeKey = `test:${id}:${Date.now()}`;
  const payload = {
    event: "test",
    at: new Date().toISOString(),
    cause: null,
    monitor: null,
    incident: null,
  };

  await pool.query(
    `INSERT INTO notification_outbox (channel_id, monitor_id, incident_id, event_type, payload, dedupe_key)
     VALUES ($1, NULL, NULL, 'test', $2, $3)`,
    [id, JSON.stringify(payload), dedupeKey]
  );

  res.status(202).json({ queued: true });
});
