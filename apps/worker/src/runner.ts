import os from "node:os";
import type { Redis } from "ioredis";
import { probeHttp, type ProbeResult } from "@pharos/probe";
import {
  acquireLock,
  releaseLock,
  readJobs,
  reclaimStale,
  ackJobs,
  type Job,
} from "@pharos/queue";
import { config } from "./config";
import { logger } from "./logger";
import type { ResultBuffer } from "./buffer";
import type { MonitorCache } from "./monitors";

const RETRYABLE_ERRORS = new Set([
  "timeout",
  "dns",
  "refused",
  "reset",
  "network",
  "tls",
]);

export class JobRunner {
  private consumerName: string;
  private stopped = false;
  private inFlight = new Set<Promise<void>>();
  private reaperTimer: NodeJS.Timeout | null = null;
  private loopPromise: Promise<void> = Promise.resolve();

  constructor(
    private redis: Redis,
    private reader: Redis,
    private buffer: ResultBuffer,
    private monitorCache: MonitorCache
  ) {
    this.consumerName = `${os.hostname()}-${process.pid}`;
  }

  getConsumerName(): string {
    return this.consumerName;
  }

  async start(): Promise<void> {
    logger.info({ consumer: this.consumerName }, "starting job runner");

    this.reaperTimer = setInterval(() => {
      this.reap();
    }, 15_000);

    this.loopPromise = this.readLoop();
  }

  private async readLoop(): Promise<void> {
    while (!this.stopped) {
      const freeSlots = Math.max(0, config.PROBE_CONCURRENCY - this.inFlight.size);
      if (freeSlots <= 0) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }

      const count = Math.min(freeSlots, 100);
      try {
        const jobs = await readJobs(this.reader, this.consumerName, count, 1000);
        for (const job of jobs) {
          this.dispatchJob(job);
        }
      } catch (err) {
        if (this.stopped) break;
        logger.error({ err }, "error reading jobs from stream");
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  private async reap(): Promise<void> {
    if (this.stopped) return;
    try {
      const freeSlots = Math.max(0, config.PROBE_CONCURRENCY - this.inFlight.size);
      if (freeSlots <= 0) return;
      const count = Math.min(freeSlots, 100);
      const reclaimed = await reclaimStale(
        this.redis,
        this.consumerName,
        config.VISIBILITY_TIMEOUT_MS,
        count
      );
      if (reclaimed.length > 0) {
        logger.info({ count: reclaimed.length }, "reclaimed stale jobs");
        for (const job of reclaimed) {
          this.dispatchJob(job);
        }
      }
    } catch (err) {
      logger.error({ err }, "error reclaiming stale jobs");
    }
  }

  private dispatchJob(job: Job): void {
    const promise = (async () => {
      try {
        await this.handleJob(job);
      } catch (err) {
        logger.error(
          { err, monitorId: job.monitorId, streamId: job.streamId },
          "unexpected crash in job handling"
        );
        try {
          await ackJobs(this.redis, [job.streamId]);
        } catch (ackErr) {
          logger.error({ ackErr }, "failed to ack crashed job");
        }
      }
    })().finally(() => {
      this.inFlight.delete(promise);
    });

    this.inFlight.add(promise);
  }

  private async handleJob(job: Job): Promise<void> {
    const monitor = await this.monitorCache.get(job.monitorId);
    if (!monitor || monitor.paused) {
      await ackJobs(this.redis, [job.streamId]);
      return;
    }

    const now = Date.now();
    const maxAge = Math.max(2 * job.intervalMs, 120_000);
    if (now - job.slotMs > maxAge) {
      await ackJobs(this.redis, [job.streamId]);
      logger.info({ monitorId: job.monitorId, lag: now - job.slotMs }, "dropped stale job");
      return;
    }

    const timeoutMs = monitor.timeoutMs ?? 10_000;
    const lockTtl = timeoutMs * (config.MAX_CONFIRMATIONS + 1) + 15_000;
    const acquired = await acquireLock(this.redis, job.monitorId, this.consumerName, lockTtl);
    if (!acquired) {
      await ackJobs(this.redis, [job.streamId]);
      logger.info({ monitorId: job.monitorId }, "skipped overlapping job (lock not acquired)");
      return;
    }

    try {
      const lagMs = Date.now() - job.slotMs;

      let attempts = 0;
      let result: ProbeResult;

      do {
        attempts++;
        result = await probeHttp({
          url: monitor.url,
          method: monitor.method,
          timeoutMs: monitor.timeoutMs,
          expectedStatus: monitor.expectedStatus,
          keyword: monitor.keyword ?? undefined,
          allowPrivate: config.PROBE_ALLOW_PRIVATE,
        });

        const shouldRetry =
          !result.ok &&
          (RETRYABLE_ERRORS.has(result.errorCode ?? "") ||
            (result.statusCode !== null && result.statusCode >= 500)) &&
          attempts <= config.MAX_CONFIRMATIONS;

        if (shouldRetry) {
          const delay = attempts * 1000 * (0.8 + Math.random() * 0.4);
          await new Promise((r) => setTimeout(r, delay));
        } else {
          break;
        }
      } while (true);

      this.buffer.add({
        time: new Date(job.slotMs),
        monitor_id: job.monitorId,
        region: config.REGION,
        ok: result.ok,
        status_code: result.statusCode,
        latency_ms: result.latencyMs,
        dns_ms: result.dnsMs,
        tcp_ms: result.tcpMs,
        tls_ms: result.tlsMs,
        ttfb_ms: result.ttfbMs,
        error_code: result.errorCode,
        streamId: job.streamId,
      });

      logger.info(
        {
          monitorId: job.monitorId,
          ok: result.ok,
          status: result.statusCode,
          ms: result.latencyMs,
          error: result.errorCode,
          attempts,
          lagMs,
        },
        "probe finished"
      );
    } finally {
      try {
        await releaseLock(this.redis, job.monitorId, this.consumerName);
      } catch (err) {
        logger.error({ err, monitorId: job.monitorId }, "error releasing lock");
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }

    const deadline = Date.now() + 30_000;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.loopPromise;
  }
}
