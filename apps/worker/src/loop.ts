import type pg from "pg";
import { probeHttp } from "@pharos/probe";
import { config } from "./config";
import { logger } from "./logger";
import type { ResultBuffer } from "./buffer";

interface MonitorRow {
  id: string;
  url: string;
  method: "GET" | "HEAD";
  interval_s: number;
  timeout_ms: number;
  expected_status: number[];
  keyword: string | null;
}

interface ScheduleEntry {
  monitor: MonitorRow;
  nextRun: number;
}

export class ProbeLoop {
  private schedule = new Map<string, ScheduleEntry>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private inFlight = new Set<Promise<void>>();
  private stopped = false;

  constructor(
    private pool: pg.Pool,
    private buffer: ResultBuffer
  ) {}

  async start(): Promise<void> {
    await this.refreshMonitors();

    this.refreshTimer = setInterval(() => {
      this.refreshMonitors().catch((err) => {
        logger.error({ err }, "failed to refresh monitors from db");
      });
    }, 10_000);

    this.tickTimer = setInterval(() => {
      this.tick();
    }, 1_000);
  }

  private async refreshMonitors(): Promise<void> {
    const { rows } = await this.pool.query<MonitorRow>(
      `SELECT id, url, method, interval_s, timeout_ms, expected_status, keyword
       FROM monitors
       WHERE type = 'http' AND url IS NOT NULL AND NOT paused`
    );

    const activeIds = new Set<string>();
    const now = Date.now();

    for (const row of rows) {
      activeIds.add(row.id);
      const existing = this.schedule.get(row.id);
      if (existing) {
        existing.monitor = row;
      } else {
        this.schedule.set(row.id, {
          monitor: row,
          nextRun: now,
        });
      }
    }

    for (const id of this.schedule.keys()) {
      if (!activeIds.has(id)) {
        this.schedule.delete(id);
      }
    }
  }

  private tick(): void {
    if (this.stopped) return;

    const now = Date.now();
    const availableSlots = config.PROBE_CONCURRENCY - this.inFlight.size;
    if (availableSlots <= 0) return;

    const dueEntries: ScheduleEntry[] = [];
    for (const entry of this.schedule.values()) {
      if (entry.nextRun <= now) {
        dueEntries.push(entry);
      }
    }

    const toRun = dueEntries.slice(0, availableSlots);

    for (const entry of toRun) {
      const m = entry.monitor;
      entry.nextRun = now + m.interval_s * 1000;

      const probePromise = this.runProbe(m).finally(() => {
        this.inFlight.delete(probePromise);
      });

      this.inFlight.add(probePromise);
    }
  }

  private async runProbe(m: MonitorRow): Promise<void> {
    const probeStartTime = new Date(Math.floor(Date.now() / 1000) * 1000);

    try {
      const result = await probeHttp({
        url: m.url,
        method: m.method,
        timeoutMs: m.timeout_ms,
        expectedStatus: m.expected_status,
        keyword: m.keyword ?? undefined,
        allowPrivate: config.PROBE_ALLOW_PRIVATE,
      });

      this.buffer.add({
        time: probeStartTime,
        monitor_id: m.id,
        region: config.REGION,
        ok: result.ok,
        status_code: result.statusCode,
        latency_ms: result.latencyMs,
        dns_ms: result.dnsMs,
        tcp_ms: result.tcpMs,
        tls_ms: result.tlsMs,
        ttfb_ms: result.ttfbMs,
        error_code: result.errorCode,
      });

      logger.info(
        {
          monitorId: m.id,
          ok: result.ok,
          status: result.statusCode,
          ms: result.latencyMs,
          errorCode: result.errorCode,
        },
        "probe finished"
      );
    } catch (err) {
      logger.error({ err, monitorId: m.id }, "unexpected probe execution error");
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    const deadline = Date.now() + 15_000;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.all(Array.from(this.inFlight)),
        new Promise((resolve) => setTimeout(resolve, 100)),
      ]);
    }
  }
}
