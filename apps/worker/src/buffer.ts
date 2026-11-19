import type pg from "pg";
import { logger } from "./logger";

export interface CheckResultRow {
  time: Date;
  monitor_id: string;
  region: string;
  ok: boolean;
  status_code: number | null;
  latency_ms: number | null;
  dns_ms: number | null;
  tcp_ms: number | null;
  tls_ms: number | null;
  ttfb_ms: number | null;
  error_code: string | null;
  streamId: string;
}

export class ResultBuffer {
  private queue: CheckResultRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly MAX_QUEUE_SIZE = 10_000;
  private readonly BATCH_SIZE = 500;
  private readonly FLUSH_INTERVAL_MS = 500;

  constructor(
    private pool: pg.Pool,
    private onFlushed?: (rows: CheckResultRow[]) => Promise<void>
  ) {
    this.timer = setInterval(() => {
      this.triggerFlush();
    }, this.FLUSH_INTERVAL_MS);
  }

  add(row: CheckResultRow): void {
    if (this.queue.length >= this.MAX_QUEUE_SIZE) {
      this.queue.shift();
    }
    this.queue.push(row);
    if (this.queue.length >= this.BATCH_SIZE) {
      this.triggerFlush();
    }
  }

  private triggerFlush(): void {
    this.flushPromise = this.flushPromise
      .then(() => this.flushBatch())
      .catch((err) => {
        logger.error({ err }, "unexpected error in buffer flush chain");
      });
  }

  private async flushBatch(): Promise<void> {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.BATCH_SIZE);
    if (batch.length === 0) return;

    try {
      const times = batch.map((r) => r.time);
      const monitorIds = batch.map((r) => r.monitor_id);
      const regions = batch.map((r) => r.region);
      const oks = batch.map((r) => r.ok);
      const statusCodes = batch.map((r) => r.status_code);
      const latencyMs = batch.map((r) => r.latency_ms);
      const dnsMs = batch.map((r) => r.dns_ms);
      const tcpMs = batch.map((r) => r.tcp_ms);
      const tlsMs = batch.map((r) => r.tls_ms);
      const ttfbMs = batch.map((r) => r.ttfb_ms);
      const errorCodes = batch.map((r) => r.error_code);

      const query = `
        INSERT INTO check_results (
          time, monitor_id, region, ok, status_code,
          latency_ms, dns_ms, tcp_ms, tls_ms, ttfb_ms, error_code
        )
        SELECT * FROM unnest(
          $1::timestamptz[],
          $2::uuid[],
          $3::text[],
          $4::boolean[],
          $5::smallint[],
          $6::int[],
          $7::int[],
          $8::int[],
          $9::int[],
          $10::int[],
          $11::text[]
        )
        ON CONFLICT (monitor_id, region, time) DO NOTHING
      `;

      await this.pool.query(query, [
        times,
        monitorIds,
        regions,
        oks,
        statusCodes,
        latencyMs,
        dnsMs,
        tcpMs,
        tlsMs,
        ttfbMs,
        errorCodes,
      ]);

      if (this.onFlushed) {
        try {
          await this.onFlushed(batch);
        } catch (err) {
          logger.error({ err }, "error in ResultBuffer onFlushed callback");
        }
      }
    } catch (err) {
      logger.error({ err, batchSize: batch.length }, "failed to flush check results, putting rows back");
      this.queue.unshift(...batch);
      if (this.queue.length > this.MAX_QUEUE_SIZE) {
        this.queue.splice(this.MAX_QUEUE_SIZE);
      }
    }
  }

  async flush(): Promise<void> {
    this.triggerFlush();
    await this.flushPromise;
    while (this.queue.length > 0) {
      const lenBefore = this.queue.length;
      this.triggerFlush();
      await this.flushPromise;
      if (this.queue.length >= lenBefore) {
        break;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
