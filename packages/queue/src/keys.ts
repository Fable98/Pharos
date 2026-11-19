export const SCHEDULE_KEY = "sched:due";
export const INTERVALS_KEY = "sched:interval";
export const JOBS_STREAM = "probe:jobs";
export const GROUP = "probers";
export const STREAM_MAXLEN = 100_000;
export const lockKey = (monitorId: string) => `lock:probe:${monitorId}`;
