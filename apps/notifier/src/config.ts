import { z } from "zod";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z
    .string()
    .optional()
    .transform((val) => (val && val.trim() !== "" ? val.trim() : undefined)),
  NOTIFY_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
  NOTIFY_BASE_DELAY_S: z.coerce.number().int().min(1).default(15),
  PROBE_ALLOW_PRIVATE: z
    .preprocess((val) => val === "true" || val === true, z.boolean())
    .default(false),
});

export const config = schema.parse(process.env);

if (config.NODE_ENV === "production" && config.PROBE_ALLOW_PRIVATE) {
  throw new Error(
    "PROBE_ALLOW_PRIVATE cannot be true in production environment"
  );
}
