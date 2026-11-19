import { z } from "zod";

export const telegramChannelSchema = z.object({
  type: z.literal("telegram"),
  name: z.string().trim().min(1).max(60),
  chatId: z.string().regex(/^-?\d{1,20}$/, "Invalid Telegram chat ID"),
});

export const webhookChannelSchema = z.object({
  type: z.literal("webhook"),
  name: z.string().trim().min(1).max(60),
  url: z
    .string()
    .url()
    .max(2048)
    .refine((u) => /^https?:\/\//.test(u), "Only http(s) URLs"),
});

export const createChannelSchema = z.discriminatedUnion("type", [
  telegramChannelSchema,
  webhookChannelSchema,
]);

export type CreateChannelInput = z.infer<typeof createChannelSchema>;
