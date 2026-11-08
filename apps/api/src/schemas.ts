import { z } from "zod";

export const createLinkSchema = z.object({
  name: z.string().trim().min(1).max(80),
  destinationUrl: z.url().max(2048).refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "Use an http or https URL."),
  slug: z.string().trim().min(3).max(48).regex(/^[a-zA-Z0-9_-]+$/, "Use letters, numbers, hyphens, or underscores.").optional(),
});

export const updateLinkSchema = createLinkSchema.pick({ name: true, destinationUrl: true }).partial().refine((value) => Object.keys(value).length > 0, "Provide at least one field to update.");

export const createRuleSchema = z.object({
  countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/, "Use a two-letter country code.").optional(),
  device: z.enum(["mobile", "desktop"]).optional(),
  destinationUrl: createLinkSchema.shape.destinationUrl,
}).refine((value) => value.countryCode !== undefined || value.device !== undefined, "Add a country or device condition.");

export const visitorSchema = z.object({
  countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/).optional(),
  device: z.enum(["mobile", "desktop", "unknown"]).optional(),
});
