import { z } from "zod";

const RedisSchema = z.object({
  url: z
    .string()
    .url()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  token: z
    .string()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  prefix: z.string().default("slack-hubspot-agent"),
});

const SlackSchema = z.object({
  signingSecret: z.string(),
  botToken: z.string(),
  appId: z.string().optional(),
});

const ZapierSchema = z.object({
  mcpUrl: z.string().url(),
  apiKey: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
});

const PostgresSchema = z.object({
  url: z
    .string()
    .url()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
});

const AiSchema = z.object({
  supervisorModel: z.string().default("gpt-5-reasoning-preview"),
  intentModel: z.string().default("gpt-4o-mini"),
  executorModel: z.string().default("gpt-4o"),
  enableTelemetry: z
    .string()
    .optional()
    .transform((value) => value === "1" || value === "true"),
});

const ConfigSchema = z.object({
  slack: SlackSchema,
  redis: RedisSchema,
  zapier: ZapierSchema,
  postgres: PostgresSchema,
  ai: AiSchema,
});

export type AppConfig = z.infer<typeof ConfigSchema>;

const rawConfig = ConfigSchema.parse({
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
  zapier: {
    mcpUrl: process.env.ZAPIER_MCP_URL,
    apiKey: process.env.ZAPIER_MCP_API_KEY,
  },
  postgres: {
    url: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  },
  ai: {
    supervisorModel:
      process.env.AI_SUPERVISOR_MODEL || "gpt-5-reasoning-preview",
    intentModel: process.env.AI_INTENT_MODEL || "gpt-4o-mini",
    executorModel: process.env.AI_EXECUTOR_MODEL || "gpt-4o",
    enableTelemetry: process.env.AI_TELEMETRY_ENABLED,
  },
});

const stripOpenAIPrefix = (model: string) =>
  model.startsWith("openai:") ? model.slice("openai:".length) : model;

export const appConfig: AppConfig = {
  ...rawConfig,
  ai: {
    ...rawConfig.ai,
    supervisorModel: stripOpenAIPrefix(rawConfig.ai.supervisorModel),
    intentModel: stripOpenAIPrefix(rawConfig.ai.intentModel),
    executorModel: stripOpenAIPrefix(rawConfig.ai.executorModel),
  },
};
