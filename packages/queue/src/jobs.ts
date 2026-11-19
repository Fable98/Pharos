import type { Redis } from "ioredis";
import { GROUP, JOBS_STREAM } from "./keys";

export type Job = { streamId: string; monitorId: string; slotMs: number; intervalMs: number };
type Entry = [string, string[]];

function toJobs(entries: Entry[]): Job[] {
  return entries
    .filter(([, fields]) => Array.isArray(fields))
    .map(([streamId, fields]) => {
      const f: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) f[fields[i]] = fields[i + 1];
      return { streamId, monitorId: f.monitor_id, slotMs: Number(f.slot), intervalMs: Number(f.interval_ms) };
    });
}

export async function ensureGroup(redis: Redis): Promise<void> {
  try {
    await redis.xgroup("CREATE", JOBS_STREAM, GROUP, "0", "MKSTREAM");
  } catch (err) {
    if (!String((err as Error).message).includes("BUSYGROUP")) throw err; // group already exists
  }
}

// Use a dedicated connection for this call: BLOCK ties up the connection while waiting.
export async function readJobs(reader: Redis, consumer: string, count: number, blockMs: number): Promise<Job[]> {
  const res = (await reader.call(
    "XREADGROUP", "GROUP", GROUP, consumer, "COUNT", String(count),
    "BLOCK", String(blockMs), "STREAMS", JOBS_STREAM, ">"
  )) as any;
  if (!res) return [];
  const entries: Entry[] = Array.isArray(res[0]) ? res[0][1] : res[1];
  return Array.isArray(entries) ? toJobs(entries) : [];
}

// Take over jobs that another consumer received but never acknowledged for minIdleMs.
export async function reclaimStale(redis: Redis, consumer: string, minIdleMs: number, count: number): Promise<Job[]> {
  const res = (await redis.call(
    "XAUTOCLAIM", JOBS_STREAM, GROUP, consumer, String(minIdleMs), "0-0", "COUNT", String(count)
  )) as [string, Entry[]];
  return toJobs(res[1]);
}

export async function ackJobs(redis: Redis, streamIds: string[]): Promise<void> {
  if (streamIds.length > 0) await redis.xack(JOBS_STREAM, GROUP, ...streamIds);
}
