import type { Redis } from "ioredis";
import { lockKey } from "./keys";

export async function acquireLock(redis: Redis, monitorId: string, owner: string, ttlMs: number): Promise<boolean> {
  return (await redis.set(lockKey(monitorId), owner, "PX", ttlMs, "NX")) === "OK";
}

export async function releaseLock(redis: Redis, monitorId: string, owner: string): Promise<void> {
  await (redis as any).releaseLock(lockKey(monitorId), owner);
}
