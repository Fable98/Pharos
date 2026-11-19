import { Redis } from "ioredis";
import { CLAIM_DUE, RELEASE_LOCK } from "./scripts";

export type { Redis };

export function createRedis(url: string, name: string, db?: number): Redis {
  const redis = new Redis(url, { connectionName: name, ...(db === undefined ? {} : { db }) });
  redis.defineCommand("claimDue", { numberOfKeys: 3, lua: CLAIM_DUE });
  redis.defineCommand("releaseLock", { numberOfKeys: 1, lua: RELEASE_LOCK });
  return redis;
}
