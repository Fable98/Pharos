import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ackJobs,
  acquireLock,
  claimDue,
  createRedis,
  ensureGroup,
  GROUP,
  INTERVALS_KEY,
  JOBS_STREAM,
  readJobs,
  reclaimStale,
  reconcileSchedule,
  releaseLock,
  SCHEDULE_KEY,
} from "./index";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";
const redis = createRedis(url, "test", 15);

beforeEach(async () => {
  await redis.flushdb();
});
afterAll(async () => {
  await redis.flushdb();
  await redis.quit();
});

describe("claimDue", () => {
  it("claims only due monitors and advances them by one interval", async () => {
    const now = 1_000_000;
    await redis.hset(INTERVALS_KEY, "a", 60000, "b", 60000);
    await redis.zadd(SCHEDULE_KEY, now - 100, "a", now + 5000, "b");
    expect(await claimDue(redis, now)).toBe(1);
    expect(await redis.zscore(SCHEDULE_KEY, "a")).toBe(String(now - 100 + 60000));
    expect(await redis.zscore(SCHEDULE_KEY, "b")).toBe(String(now + 5000));
    const entries = await redis.xrange(JOBS_STREAM, "-", "+");
    expect(entries).toHaveLength(1);
    expect(entries[0][1]).toContain(String(now - 100)); // the job carries the scheduled slot
  });

  it("skips missed slots instead of firing a burst", async () => {
    const now = 10_000_000;
    await redis.hset(INTERVALS_KEY, "a", 60000);
    await redis.zadd(SCHEDULE_KEY, now - 600_000, "a");
    expect(await claimDue(redis, now)).toBe(1);
    expect(await redis.zscore(SCHEDULE_KEY, "a")).toBe(String(now + 60000));
  });

  it("drops monitors that no longer have an interval", async () => {
    await redis.zadd(SCHEDULE_KEY, 1, "ghost");
    expect(await claimDue(redis, 1000)).toBe(0);
    expect(await redis.zscore(SCHEDULE_KEY, "ghost")).toBeNull();
  });

  it("never hands the same slot to two competing schedulers", async () => {
    const now = Date.now();
    for (let i = 0; i < 200; i++) {
      await redis.hset(INTERVALS_KEY, `m${i}`, 60000);
      await redis.zadd(SCHEDULE_KEY, now - 1000, `m${i}`);
    }
    const other = createRedis(url, "test2", 15);
    const drain = async (r: typeof redis) => {
      let total = 0;
      let n: number;
      do {
        n = await claimDue(r, now, 20);
        total += n;
      } while (n > 0);
      return total;
    };
    const [a, b] = await Promise.all([drain(redis), drain(other)]);
    await other.quit();
    expect(a + b).toBe(200);
    expect(await redis.xlen(JOBS_STREAM)).toBe(200);
  });
});

describe("reconcileSchedule", () => {
  it("adds with jitter, keeps existing schedules, and removes deleted monitors", async () => {
    const now = 1_000_000;
    await reconcileSchedule(redis, [{ id: "a", intervalS: 30 }, { id: "b", intervalS: 60 }], now);
    expect(await redis.zcard(SCHEDULE_KEY)).toBe(2);
    const a = Number(await redis.zscore(SCHEDULE_KEY, "a"));
    expect(a).toBeGreaterThanOrEqual(now);
    expect(a).toBeLessThan(now + 30000);

    const before = await redis.zscore(SCHEDULE_KEY, "b");
    const r = await reconcileSchedule(redis, [{ id: "b", intervalS: 60 }], now + 1000);
    expect(r.removed).toBe(1);
    expect(await redis.zscore(SCHEDULE_KEY, "a")).toBeNull();
    expect(await redis.hget(INTERVALS_KEY, "a")).toBeNull();
    expect(await redis.zscore(SCHEDULE_KEY, "b")).toBe(before);
  });
});

describe("locks", () => {
  it("are exclusive and only the owner can release", async () => {
    expect(await acquireLock(redis, "m1", "w1", 5000)).toBe(true);
    expect(await acquireLock(redis, "m1", "w2", 5000)).toBe(false);
    await releaseLock(redis, "m1", "w2");
    expect(await acquireLock(redis, "m1", "w2", 5000)).toBe(false);
    await releaseLock(redis, "m1", "w1");
    expect(await acquireLock(redis, "m1", "w2", 5000)).toBe(true);
  });
});

describe("streams", () => {
  it("lets another consumer reclaim a job a dead consumer never acknowledged", async () => {
    await redis.hset(INTERVALS_KEY, "a", 1000);
    await redis.zadd(SCHEDULE_KEY, 1, "a");
    await claimDue(redis, 10);
    await ensureGroup(redis);
    const first = await readJobs(redis, "c1", 10, 1);
    expect(first).toHaveLength(1);
    const taken = await reclaimStale(redis, "c2", 0, 10);
    expect(taken.map((j) => j.monitorId)).toEqual(["a"]);
    await ackJobs(redis, taken.map((j) => j.streamId));
    const pending = (await redis.xpending(JOBS_STREAM, GROUP)) as unknown as [number];
    expect(pending[0]).toBe(0);
  });
});
