import type { Pool } from "pg";
import { BlockedTargetError, safePostJson } from "@pharos/probe";
import type { AlertPayload } from "@pharos/shared";
import { config } from "./config";
import { backoffMs, sign, telegramText } from "./delivery";
import { logger } from "./logger";

interface ClaimedRow {
  id: string;
  channel_id: string;
  event_type: string;
  payload: AlertPayload;
  attempts: number;
}

interface ChannelRow {
  id: string;
  type: "telegram" | "webhook";
  config: any;
  enabled: boolean;
}

export class Notifier {
  private running = false;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = 0;

  constructor(private readonly pool: Pool) {}

  async start(): Promise<void> {
    this.running = true;
    logger.info("starting notifier");

    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        logger.error({ err }, "error during notifier tick");
      });
    }, 1000);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.busy) return;
    this.busy = true;

    try {
      const res = await this.pool.query<ClaimedRow>(
        `UPDATE notification_outbox o
         SET attempts = o.attempts + 1,
             next_attempt_at = now() + interval '60 seconds'
         FROM (
           SELECT id FROM notification_outbox
           WHERE status = 'pending' AND next_attempt_at <= now()
           ORDER BY next_attempt_at
           LIMIT 20
           FOR UPDATE SKIP LOCKED
         ) due
         WHERE o.id = due.id
         RETURNING o.id, o.channel_id, o.event_type, o.payload, o.attempts`
      );

      const rows = res.rows;
      if (rows.length > 0) {
        logger.debug({ count: rows.length }, "claimed due outbox notifications");
        await Promise.all(rows.map((row) => this.deliverRow(row)));
      }
    } finally {
      this.busy = false;
    }
  }

  private async deliverRow(row: ClaimedRow): Promise<void> {
    this.inFlight++;
    try {
      // 1. Load channel
      const chRes = await this.pool.query<ChannelRow>(
        `SELECT id, type, config, enabled FROM alert_channels WHERE id = $1`,
        [row.channel_id]
      );
      const channel = chRes.rows[0];

      if (!channel || !channel.enabled) {
        const errorMsg = !channel
          ? "channel does not exist"
          : "channel is disabled";
        await this.handleFailure(row, new Error(errorMsg), true);
        return;
      }

      // 2. Deliver based on channel type
      if (channel.type === "telegram") {
        await this.deliverTelegram(row, channel);
      } else if (channel.type === "webhook") {
        await this.deliverWebhook(row, channel);
      } else {
        await this.handleFailure(
          row,
          new Error(`unknown channel type: ${(channel as any).type}`),
          true
        );
        return;
      }

      // 3. Mark success
      await this.pool.query(
        `UPDATE notification_outbox SET
           status = 'sent',
           sent_at = now(),
           last_error = NULL
         WHERE id = $1`,
        [row.id]
      );
      logger.info(
        { outboxId: row.id, channelId: channel.id, type: channel.type },
        "notification delivered successfully"
      );
    } catch (err: any) {
      const isBlocked =
        err instanceof BlockedTargetError || err?.code === "PHAROS_BLOCKED";
      const isPermanent = err?.isPermanent === true || isBlocked;
      await this.handleFailure(row, err, isPermanent);
    } finally {
      this.inFlight--;
    }
  }

  private async deliverTelegram(
    row: ClaimedRow,
    channel: ChannelRow
  ): Promise<void> {
    if (!config.TELEGRAM_BOT_TOKEN) {
      const err = new Error("TELEGRAM_BOT_TOKEN is not set");
      (err as any).isPermanent = true;
      throw err;
    }

    const text = telegramText(row.payload);
    const chatId = channel.config.chatId;

    // NEVER log this URL as it contains the secret token
    const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      return;
    }

    const resBody = await res.text().catch(() => "");
    const err = new Error(`Telegram API responded with ${res.status}: ${resBody.slice(0, 100)}`);

    if ([400, 401, 403, 404].includes(res.status)) {
      (err as any).isPermanent = true;
    }

    throw err;
  }

  private async deliverWebhook(
    row: ClaimedRow,
    channel: ChannelRow
  ): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ id: row.id, ...row.payload });
    const signature = sign(channel.config.secret, timestamp, body);

    const headers: Record<string, string> = {
      "x-pharos-event": row.payload.event,
      "x-pharos-event-id": row.id,
      "x-pharos-timestamp": String(timestamp),
      "x-pharos-signature": signature,
    };

    const res = await safePostJson(channel.config.url, body, headers, {
      timeoutMs: 10000,
      allowPrivate: config.PROBE_ALLOW_PRIVATE,
    });

    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `Webhook returned status ${res.status}: ${res.body.slice(0, 100)}`
      );
    }
  }

  private async handleFailure(
    row: ClaimedRow,
    err: any,
    isPermanent: boolean
  ): Promise<void> {
    const errorMsg = String(err?.message ?? err).slice(0, 300);
    const permanent = isPermanent || row.attempts >= config.NOTIFY_MAX_ATTEMPTS;

    if (permanent) {
      await this.pool.query(
        `UPDATE notification_outbox SET
           status = 'failed',
           last_error = $2
         WHERE id = $1`,
        [row.id, errorMsg]
      );
      logger.error(
        {
          outboxId: row.id,
          attempts: row.attempts,
          error: errorMsg,
          permanent: true,
        },
        "failed permanently"
      );
    } else {
      const delayMs = backoffMs(row.attempts, config.NOTIFY_BASE_DELAY_S);
      await this.pool.query(
        `UPDATE notification_outbox SET
           next_attempt_at = now() + ($2 || ' milliseconds')::interval,
           last_error = $3
         WHERE id = $1`,
        [row.id, String(delayMs), errorMsg]
      );
      logger.warn(
        {
          outboxId: row.id,
          attempts: row.attempts,
          delayMs,
          error: errorMsg,
        },
        "will retry"
      );
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);

    const start = Date.now();
    while (this.inFlight > 0 && Date.now() - start < 30000) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
