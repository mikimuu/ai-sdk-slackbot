import { z } from "zod";

const RedisSchema = z
  .object({
    url: z.string().url(),
    token: z.string(),
    prefix: z.string().default("slack-hubspot-agent"),
  })
  .refine((value) => value.url.length > 0 && value.token.length > 0, {
    message: "REDIS_URL and REDIS_TOKEN are required",
  });

const SlackSchema = z.object({
  signingSecret: z.string(),
  botToken: z.string(),
  appId: z.string().optional(),
});

const HubSpotSchema = z.object({
  accessToken: z.string().min(1, "HUBSPOT_PRIVATE_APP_TOKEN is required"),
});

const ZapierSchema = z.object({
  mcpUrl: z.string().url(),
  apiKey: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
});

const PostgresSchema = z.object({
  url: z.string().url(),
});

const AiSchema = z.object({
  supervisorModel: z.string().default("openai:gpt-5"),
  intentModel: z.string().default("openai:gpt-4o-mini"),
  executorModel: z.string().default("openai:gpt-4o"),
  enableTelemetry: z
    .string()
    .optional()
    .transform((value) => value === "1" || value === "true"),
});

const ConfigSchema = z.object({
  slack: SlackSchema,
  redis: RedisSchema,
  hubspot: HubSpotSchema,
  zapier: ZapierSchema,
  postgres: PostgresSchema,
  ai: AiSchema,
});

export type AppConfig = z.infer<typeof ConfigSchema>;

const config: AppConfig = ConfigSchema.parse({
  slack: {
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    botToken: process.env.SLACK_BOT_TOKEN,
    appId: process.env.SLACK_APP_ID,
  },
  redis: {
    url: process.env.REDIS_REST_URL,
    token: process.env.REDIS_REST_TOKEN,
    prefix: process.env.REDIS_PREFIX,
  },
  hubspot: {
    accessToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN,
  },
  zapier: {
    mcpUrl: process.env.ZAPIER_MCP_URL,
    apiKey: process.env.ZAPIER_MCP_API_KEY,
  },
  postgres: {
    url: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  },
  ai: {
    supervisorModel:
      process.env.AI_SUPERVISOR_MODEL || "openai:gpt-5-reasoning-preview",
    intentModel: process.env.AI_INTENT_MODEL || "openai:gpt-4o-mini",
    executorModel: process.env.AI_EXECUTOR_MODEL || "openai:gpt-4o",
    enableTelemetry: process.env.AI_TELEMETRY_ENABLED,
  },
});

export const appConfig = config;
