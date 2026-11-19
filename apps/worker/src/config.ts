import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  REGION: z.string().default("primary"),
  PROBE_CONCURRENCY: z.coerce.number().int().min(1).default(50),
  PROBE_ALLOW_PRIVATE: z
    .preprocess((val) => val === "true" || val === true, z.boolean())
    .default(false),
});

export const config = schema.parse(process.env);

if (config.NODE_ENV === "production" && config.PROBE_ALLOW_PRIVATE) {
  throw new Error("PROBE_ALLOW_PRIVATE cannot be true in production environment");
}
