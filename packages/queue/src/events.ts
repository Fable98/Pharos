import type { Redis } from "ioredis";

export const RESULTS_STREAM = "results:events";
export const RESULTS_GROUP = "alerting";
export const RESULTS_STREAM_MAXLEN = 100000;

export interface ResultEvent {
  streamId: string;
  monitorId: string;
  atMs: number;
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  errorCode: string | null;
}

type Entry = [string, string[]];

function toResultEvents(entries: Entry[]): ResultEvent[] {
  return entries
    .filter(([, fields]) => Array.isArray(fields))
    .map(([streamId, fields]) => {
      const f: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        f[fields[i]] = fields[i + 1];
      }
      return {
        streamId,
        monitorId: f.monitor_id,
        atMs: Number(f.at),
        ok: f.ok === "1",
        statusCode: f.status && f.status !== "" ? Number(f.status) : null,
        latencyMs: f.latency && f.latency !== "" ? Number(f.latency) : null,
        errorCode: f.error && f.error !== "" ? f.error : null,
      };
    });
}

export type PublishResultRow = {
  time: Date;
  ok: boolean;
  monitorId?: string;
  monitor_id?: string;
  statusCode?: number | null;
  status_code?: number | null;
  latencyMs?: number | null;
  latency_ms?: number | null;
  errorCode?: string | null;
  error_code?: string | null;
};

export async function publishResults(
  redis: Redis,
  rows: PublishResultRow[]
): Promise<void> {
  if (rows.length === 0) return;

  const pipeline = redis.pipeline();
  for (const row of rows) {
    const monitorId = row.monitorId ?? row.monitor_id ?? "";
    const statusCode =
      row.statusCode !== undefined ? row.statusCode : row.status_code ?? null;
    const latencyMs =
      row.latencyMs !== undefined ? row.latencyMs : row.latency_ms ?? null;
    const errorCode =
      row.errorCode !== undefined ? row.errorCode : row.error_code ?? null;

    pipeline.xadd(
      RESULTS_STREAM,
      "MAXLEN",
      "~",
      RESULTS_STREAM_MAXLEN,
      "*",
      "monitor_id",
      monitorId,
      "at",
      String(row.time.getTime()),
      "ok",
      row.ok ? "1" : "0",
      "status",
      statusCode !== null ? String(statusCode) : "",
      "latency",
      latencyMs !== null ? String(latencyMs) : "",
      "error",
      errorCode ?? ""
    );
  }

  const results = await pipeline.exec();
  if (results) {
    for (const [err] of results) {
      if (err) throw err;
    }
  }
}

export async function ensureResultsGroup(redis: Redis): Promise<void> {
  try {
    await redis.xgroup("CREATE", RESULTS_STREAM, RESULTS_GROUP, "0", "MKSTREAM");
  } catch (err) {
    if (!String((err as Error).message).includes("BUSYGROUP")) throw err;
  }
}

export async function readResultEvents(
  reader: Redis,
  consumer: string,
  count: number,
  blockMs: number
): Promise<ResultEvent[]> {
  const res = (await reader.call(
    "XREADGROUP",
    "GROUP",
    RESULTS_GROUP,
    consumer,
    "COUNT",
    String(count),
    "BLOCK",
    String(blockMs),
    "STREAMS",
    RESULTS_STREAM,
    ">"
  )) as any;

  if (!res) return [];
  const entries: Entry[] = Array.isArray(res[0]) ? res[0][1] : res[1];
  return Array.isArray(entries) ? toResultEvents(entries) : [];
}

export async function reclaimResultEvents(
  redis: Redis,
  consumer: string,
  minIdleMs: number,
  count: number
): Promise<ResultEvent[]> {
  const res = (await redis.call(
    "XAUTOCLAIM",
    RESULTS_STREAM,
    RESULTS_GROUP,
    consumer,
    String(minIdleMs),
    "0-0",
    "COUNT",
    String(count)
  )) as [string, Entry[]];

  return toResultEvents(res[1]);
}

export async function ackResultEvents(
  redis: Redis,
  streamIds: string[]
): Promise<number> {
  if (streamIds.length === 0) return 0;
  return redis.xack(RESULTS_STREAM, RESULTS_GROUP, ...streamIds);
}
