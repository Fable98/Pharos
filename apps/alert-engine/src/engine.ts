import os from "node:os";
import type { Pool, PoolClient } from "pg";
import {
  ackResultEvents,
  readResultEvents,
  reclaimResultEvents,
  ResultEvent,
  type Redis,
} from "@pharos/queue";
import {
  AlertPayload,
  DEFAULT_DEGRADED_THRESHOLD,
  evaluate,
  MonitorState,
  StateConfig,
  Status,
} from "@pharos/shared";
import { config } from "./config";
import { logger } from "./logger";

export async function processEvent(
  pool: Pool,
  event: ResultEvent
): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");

    // Ensure monitor_state exists if monitor exists
    await client.query(
      `INSERT INTO monitor_state (monitor_id)
       SELECT id FROM monitors WHERE id = $1
       ON CONFLICT (monitor_id) DO NOTHING`,
      [event.monitorId]
    );

    // Lock and get state + monitor config
    const res = await client.query(
      `SELECT
         m.id, m.name, m.url, m.workspace_id,
         m.fail_threshold, m.recover_threshold, m.degraded_latency_ms,
         s.status, s.consecutive_failures, s.consecutive_successes,
         s.consecutive_slow, s.consecutive_fast, s.last_checked_at
       FROM monitor_state s
       JOIN monitors m ON m.id = s.monitor_id
       WHERE s.monitor_id = $1
       FOR UPDATE OF s`,
      [event.monitorId]
    );

    if (res.rowCount === 0) {
      // Monitor was deleted
      await client.query("COMMIT");
      return;
    }

    const row = res.rows[0];
    const prev: MonitorState = {
      status: row.status as Status,
      consecutiveFailures: Number(row.consecutive_failures),
      consecutiveSuccesses: Number(row.consecutive_successes),
      consecutiveSlow: Number(row.consecutive_slow),
      consecutiveFast: Number(row.consecutive_fast),
      lastCheckedAt: row.last_checked_at
        ? new Date(row.last_checked_at).getTime()
        : null,
    };

    const cfg: StateConfig = {
      failThreshold: Number(row.fail_threshold),
      recoverThreshold: Number(row.recover_threshold),
      degradedLatencyMs:
        row.degraded_latency_ms !== null
          ? Number(row.degraded_latency_ms)
          : null,
      degradedThreshold: DEFAULT_DEGRADED_THRESHOLD,
    };

    const { state: nextState, events, ignored } = evaluate(
      prev,
      {
        atMs: event.atMs,
        ok: event.ok,
        latencyMs: event.latencyMs,
        errorCode: event.errorCode,
      },
      cfg
    );

    if (ignored) {
      await client.query("COMMIT");
      return;
    }

    // Update monitor_state
    await client.query(
      `UPDATE monitor_state SET
         status = $2,
         consecutive_failures = $3,
         consecutive_successes = $4,
         consecutive_slow = $5,
         consecutive_fast = $6,
         last_checked_at = to_timestamp($7 / 1000.0),
         last_changed_at = CASE WHEN status <> $2 THEN now() ELSE last_changed_at END
       WHERE monitor_id = $1`,
      [
        row.id,
        nextState.status,
        nextState.consecutiveFailures,
        nextState.consecutiveSuccesses,
        nextState.consecutiveSlow,
        nextState.consecutiveFast,
        nextState.lastCheckedAt,
      ]
    );

    // Process state change events
    if (events.length > 0) {
      const channelsRes = await client.query(
        `SELECT id FROM alert_channels WHERE workspace_id = $1 AND enabled = true`,
        [row.workspace_id]
      );
      const channels = channelsRes.rows;

      for (const ev of events) {
        logger.info(
          {
            monitorId: row.id,
            type: ev.type,
            cause: ev.cause,
            status: nextState.status,
          },
          "state change event emitted"
        );

        let incidentRow: {
          id: string;
          started_at: Date;
          resolved_at: Date | null;
        } | null = null;

        if (ev.type === "incident_opened") {
          const incRes = await client.query(
            `INSERT INTO incidents (monitor_id, started_at, cause)
             VALUES ($1, to_timestamp($2 / 1000.0), $3)
             ON CONFLICT (monitor_id) WHERE resolved_at IS NULL
             DO UPDATE SET cause = incidents.cause
             RETURNING id, started_at, resolved_at`,
            [row.id, ev.atMs, ev.cause]
          );
          incidentRow = incRes.rows[0] ?? null;
        } else if (ev.type === "recovered") {
          const incRes = await client.query(
            `UPDATE incidents
             SET resolved_at = to_timestamp($2 / 1000.0)
             WHERE monitor_id = $1 AND resolved_at IS NULL
             RETURNING id, started_at, resolved_at`,
            [row.id, ev.atMs]
          );
          incidentRow = incRes.rows[0] ?? null;
        }

        let incidentInfo: AlertPayload["incident"] = null;
        if (incidentRow) {
          const startedAt = new Date(incidentRow.started_at);
          const resolvedAt = incidentRow.resolved_at
            ? new Date(incidentRow.resolved_at)
            : null;
          const durationS = resolvedAt
            ? Math.max(
                0,
                Math.round(
                  (resolvedAt.getTime() - startedAt.getTime()) / 1000
                )
              )
            : null;
          incidentInfo = {
            id: incidentRow.id,
            startedAt: startedAt.toISOString(),
            resolvedAt: resolvedAt ? resolvedAt.toISOString() : null,
            durationS,
          };
        }

        const payload: AlertPayload = {
          event: ev.type,
          at: new Date(ev.atMs).toISOString(),
          cause: ev.cause,
          monitor: {
            id: row.id,
            name: row.name,
            url: row.url,
          },
          incident: incidentInfo,
        };

        for (const channel of channels) {
          const dedupeKey = `${ev.type}:${row.id}:${ev.atMs}:${channel.id}`;
          await client.query(
            `INSERT INTO notification_outbox (
               channel_id,
               monitor_id,
               incident_id,
               event_type,
               payload,
               dedupe_key
             ) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (dedupe_key) DO NOTHING`,
            [
              channel.id,
              row.id,
              incidentRow?.id ?? null,
              ev.type,
              JSON.stringify(payload),
              dedupeKey,
            ]
          );
        }
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export class AlertEngine {
  private consumer: string;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private reaperTimer: NodeJS.Timeout | null = null;
  private inFlight = 0;

  constructor(
    private readonly redis: Redis,
    private readonly reader: Redis,
    private readonly pool: Pool
  ) {
    this.consumer = `${os.hostname()}-${process.pid}`;
  }

  async start(): Promise<void> {
    this.running = true;
    logger.info({ consumer: this.consumer }, "starting alert engine");

    this.reaperTimer = setInterval(() => {
      this.reapStale().catch((err) => {
        logger.error({ err }, "error during stale event reaping");
      });
    }, 15000);

    this.loopPromise = this.readLoop();
  }

  private async reapStale(): Promise<void> {
    if (!this.running) return;
    try {
      const reclaimed = await reclaimResultEvents(
        this.redis,
        this.consumer,
        config.EVENT_VISIBILITY_MS,
        50
      );
      if (reclaimed.length > 0) {
        logger.info(
          { count: reclaimed.length },
          "reclaimed stale result events"
        );
        for (const ev of reclaimed) {
          await this.handleEvent(ev);
        }
      }
    } catch (err) {
      logger.error({ err }, "failed to reclaim stale result events");
    }
  }

  private async handleEvent(ev: ResultEvent): Promise<void> {
    this.inFlight++;
    try {
      await processEvent(this.pool, ev);
      await ackResultEvents(this.redis, [ev.streamId]);
    } catch (err) {
      logger.error(
        { err, streamId: ev.streamId, monitorId: ev.monitorId },
        "failed to process result event"
      );
    } finally {
      this.inFlight--;
    }
  }

  private async readLoop(): Promise<void> {
    while (this.running) {
      try {
        const events = await readResultEvents(
          this.reader,
          this.consumer,
          50,
          1000
        );
        for (const ev of events) {
          if (!this.running) break;
          await this.handleEvent(ev);
        }
      } catch (err) {
        if (!this.running) break;
        logger.error({ err }, "error reading result events from stream");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reaperTimer) clearInterval(this.reaperTimer);

    if (this.loopPromise) {
      await Promise.race([
        this.loopPromise,
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    }

    // Wait for in-flight events
    const start = Date.now();
    while (this.inFlight > 0 && Date.now() - start < 30000) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
