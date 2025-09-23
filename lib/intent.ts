import { z } from "zod";

export const IntentSchema = z.object({
  action: z.enum(["read", "create", "update", "upsert", "delete", "report"]),
  object: z.enum(["contact", "company", "deal", "ticket", "custom"]),
  filters: z
    .array(
      z.object({
        field: z.string(),
        op: z.enum(["eq", "contains", "in", "gt", "lt"]),
        value: z.union([z.string(), z.number(), z.array(z.string())]),
      })
    )
    .default([]),
  fields: z.record(z.any()).default({}),
  limit: z.number().int().positive().max(500).default(50),
  confirmRequired: z.boolean().default(false),
  toolHint: z.enum(["zapier", "sdk", "auto"]).default("auto"),
  toolBudget: z
    .object({
      maxZapCalls: z.number().int().min(0).default(2),
      maxHsReads: z.number().int().min(1).default(100),
      maxHsWrites: z.number().int().min(0).default(50),
    })
    .default({}),
});

export type Intent = z.infer<typeof IntentSchema>;

export type IntentValidationResult = {
  ok: boolean;
  missingFields?: string[];
  errors?: string[];
};

export const IntentGuardrails = {
  enforceConfirmation(intent: Intent, threshold = 50) {
    if (intent.action !== "read" && intent.limit >= threshold) {
      return { ...intent, confirmRequired: true };
    }
    return intent;
  },
};
