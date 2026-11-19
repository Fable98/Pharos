import type pg from "pg";
import { logger } from "./logger";

export interface CachedMonitor {
  id: string;
  url: string;
  method: "GET" | "HEAD";
  timeoutMs: number;
  expectedStatus: number[];
  keyword: string | null;
  paused: boolean;
  intervalS: number;
}

export class MonitorCache {
  private cache = new Map<string, CachedMonitor>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private pool: pg.Pool) {}

  async start(): Promise<void> {
    await this.reload();
    this.timer = setInterval(() => this.reload(), 10_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async reload(): Promise<void> {
    if (this.stopped) return;
    try {
      const { rows } = await this.pool.query<{
        id: string;
        url: string;
        method: "GET" | "HEAD";
        timeoutMs: number;
        expectedStatus: number[];
        keyword: string | null;
        paused: boolean;
        intervalS: number;
      }>(
        `SELECT
           id,
           url,
           method,
           timeout_ms AS "timeoutMs",
           expected_status AS "expectedStatus",
           keyword,
           paused,
           interval_s AS "intervalS"
         FROM monitors
         WHERE type = 'http' AND url IS NOT NULL AND NOT paused`
      );

      const nextMap = new Map<string, CachedMonitor>();
      for (const row of rows) {
        nextMap.set(row.id, row);
      }
      this.cache = nextMap;
    } catch (err) {
      logger.error({ err }, "failed to reload monitor cache");
    }
  }

  async get(id: string): Promise<CachedMonitor | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;

    try {
      const { rows } = await this.pool.query<{
        id: string;
        url: string;
        method: "GET" | "HEAD";
        timeoutMs: number;
        expectedStatus: number[];
        keyword: string | null;
        paused: boolean;
        intervalS: number;
      }>(
        `SELECT
           id,
           url,
           method,
           timeout_ms AS "timeoutMs",
           expected_status AS "expectedStatus",
           keyword,
           paused,
           interval_s AS "intervalS"
         FROM monitors
         WHERE id = $1 AND type = 'http' AND url IS NOT NULL`,
        [id]
      );
      if (rows[0]) {
        if (!rows[0].paused) {
          this.cache.set(rows[0].id, rows[0]);
        }
        return rows[0];
      }
    } catch (err) {
      logger.error({ err, id }, "failed to fetch monitor on cache miss");
    }
    return null;
  }
}
