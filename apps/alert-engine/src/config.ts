import { z } from "zod";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  EVENT_VISIBILITY_MS: z.coerce.number().int().min(5000).default(60000),
});

export const config = schema.parse(process.env);
