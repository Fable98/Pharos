import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  REGION: z.string().default("primary"),
  PROBE_CONCURRENCY: z.coerce.number().int().min(1).default(50),
  PROBE_ALLOW_PRIVATE: z
    .preprocess((val) => val === "true" || val === true, z.boolean())
    .default(false),
  VISIBILITY_TIMEOUT_MS: z.coerce.number().int().min(10000).default(60000),
  MAX_CONFIRMATIONS: z.coerce.number().int().min(0).max(5).default(2),
});

export const config = schema.parse(process.env);

if (config.NODE_ENV === "production" && config.PROBE_ALLOW_PRIVATE) {
  throw new Error("PROBE_ALLOW_PRIVATE cannot be true in production environment");
}
