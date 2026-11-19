import type { Redis } from "ioredis";
import { INTERVALS_KEY, JOBS_STREAM, SCHEDULE_KEY, STREAM_MAXLEN } from "./keys";

export async function claimDue(redis: Redis, nowMs: number, limit = 1000): Promise<number> {
  return (redis as any).claimDue(SCHEDULE_KEY, JOBS_STREAM, INTERVALS_KEY, nowMs, limit, STREAM_MAXLEN);
}

// Make Redis match the database: add new monitors, update intervals, remove deleted or paused ones.
// New monitors start at a random offset inside their first interval so checks spread out evenly.
export async function reconcileSchedule(
  redis: Redis,
  monitors: { id: string; intervalS: number }[],
  nowMs = Date.now()
): Promise<{ added: number; removed: number }> {
  const wanted = new Map(monitors.map((m) => [m.id, m.intervalS * 1000]));
  const existing = new Set([...(await redis.zrange(SCHEDULE_KEY, 0, "-1")), ...(await redis.hkeys(INTERVALS_KEY))]);
  const pipe = redis.pipeline();
  let added = 0;
  let removed = 0;
  for (const [id, ms] of wanted) {
    pipe.hset(INTERVALS_KEY, id, ms);
    pipe.zadd(SCHEDULE_KEY, "NX", nowMs + Math.floor(Math.random() * ms), id); // NX: never reset an existing schedule
    if (!existing.has(id)) added++;
  }
  for (const id of existing) {
    if (wanted.has(id)) continue;
    pipe.zrem(SCHEDULE_KEY, id);
    pipe.hdel(INTERVALS_KEY, id);
    removed++;
  }
  await pipe.exec();
  return { added, removed };
}
