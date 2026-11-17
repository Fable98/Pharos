import { z } from "zod";

export const registerSchema = z.object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(10).max(128),
});

export const loginSchema = z.object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1).max(128),
});

export const createMonitorSchema = z.object({
    name: z.string().trim().min(1).max(100),
    url: z.string().url().max(2048).refine((u) => /^https?:\/\//.test(u), "Only http(s) URLs"),
    method: z.enum(["GET", "HEAD"]).default("GET"),
    intervalS: z.number().int().min(30).max(3600).default(60),
    timeoutMs: z.number().int().min(1000).max(30000).default(10000),
    expectedStatus: z.array(z.number().int().min(100).max(599)).min(1).max(10).default([200]),
    keyword: z.string().max(200).optional(),
});

export const updateMonitorSchema = createMonitorSchema.partial();

export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;