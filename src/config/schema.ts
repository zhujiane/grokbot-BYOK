/**
 * Zod validation schema for the shim configuration.
 *
 * The schema mirrors the `ShimConfig` / `ProviderConfig` interfaces declared
 * in `src/types.ts`. Raw config (parsed from JSON) is run through
 * `parseConfig` which both validates and applies the documented defaults.
 */
import { z } from "zod";
import type { ShimConfig } from "../types.js";

/** Default path to the config file, relative to the process cwd. */
export const DEFAULT_CONFIG_PATH = "config/config.json";

/** Validation schema for a single API key entry. */
const keyInfoSchema = z.object({
  value: z.string(),
  weight: z.number().positive().optional(),
  enabled: z.boolean().optional(),
});

/** Validation schema for per-provider network config. */
const networkConfigSchema = z.object({
  requestTimeoutMs: z.number().positive().optional(),
  maxRetries: z.number().nonnegative().optional(),
  retryBackoffInitialMs: z.number().positive().optional(),
  retryBackoffMaxMs: z.number().positive().optional(),
  streamIdleTimeoutMs: z.number().positive().optional(),
  ttfbTimeoutMs: z.number().nonnegative().optional(),
  rateLimitCooldownMs: z.number().nonnegative().optional(),
  serverErrorCooldownMs: z.number().nonnegative().optional(),
  failureThreshold: z.number().positive().optional(),
});

/** Validation schema for per-provider compat flag overrides. */
const compatOverridesSchema = z.object({
  supportsReasoningEffort: z.boolean().optional(),
  thinkingFormat: z
    .enum(["openai", "zai", "qwen", "qwen-chat-template", "openrouter"])
    .optional(),
  reasoningContentField: z.string().optional(),
  requiresAssistantContentForToolCalls: z.boolean().optional(),
  supportsMultipleSystemMessages: z.boolean().optional(),
  maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
  streamIdleTimeoutMs: z.number().positive().optional(),
  stripDeepseekSpecialTokens: z.boolean().optional(),
  supportsImages: z.boolean().optional(),
  streamMarkupHealingPattern: z
    .enum(["kimi", "dsml", "qwen", "thinking"])
    .optional(),
});

/** Validation schema for a single provider entry. */
export const providerConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string(),
  keys: z.array(keyInfoSchema).optional(),
  defaultModel: z.string(),
  models: z.record(z.string(), z.string()),
  network: networkConfigSchema.optional(),
  compat: compatOverridesSchema.optional(),
  keyless: z.boolean().optional(),
});

/** Validation schema for the `providers` block. */
const providersSchema = z.object({
  priority: z.array(z.string()),
  configs: z.record(z.string(), providerConfigSchema),
});

/** Validation schema for the `hostConfig` block. */
const hostConfigSchema = z.object({
  sandHostDir: z.string(),
  defaultModel: z.string(),
});

/** Validation schema for session affinity. */
const sessionAffinitySchema = z.object({
  enabled: z.boolean().default(false),
  ttlMs: z.number().positive().optional(),
});

/** Validation schema for the full shim configuration. */
export const videoConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().url().default("https://api.x.ai/v1"),
  apiKey: z.string().default(""),
  apiToken: z.string().default(""),
  defaultModel: z.string().min(1).default("grok-imagine-video"),
  jobsDir: z.string().min(1).default("data/video-jobs"),
  requestTimeoutMs: z.number().int().positive().default(60000),
  maxBodyBytes: z.number().int().positive().default(20 * 1024 * 1024),
}).superRefine((value, ctx) => {
  if (!value.enabled) return;
  for (const field of ["apiKey", "apiToken"] as const) {
    if (!value[field].trim() || value[field].includes("${")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "Required when video API is enabled; resolve environment placeholders first" });
    }
  }
});

export const shimConfigSchema = z.object({
  api: z.object({
    enabled: z.boolean().default(false),
    apiToken: z.string().default(""),
    allowConnect: z.boolean().default(false),
    maxBodyBytes: z.number().int().positive().default(2 * 1024 * 1024),
  }).superRefine((value, ctx) => {
    if (value.enabled && (!value.apiToken.trim() || value.apiToken.includes("${"))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["apiToken"], message: "Set API_TOKEN before enabling the REST API" });
    }
  }).optional(),
  grokBot: z.object({
    enabled: z.boolean().default(false),
    credentialsFile: z.string().min(1).default("secrets/grok-bot-session.json"),
    requestTimeoutMs: z.number().int().positive().default(30000),
    videoEnabled: z.boolean().default(false),
    chatEnabled: z.boolean().default(false),
    jobsDir: z.string().min(1).default("data/desktop-jobs"),
    jobTimeoutMs: z.number().int().positive().default(1800000),
    chatTimeoutMs: z.number().int().positive().default(120000),
    pollIntervalMs: z.number().int().min(10).default(2000),
    maxConcurrentJobs: z.number().int().min(1).max(32).default(4),
  }).optional(),
  video: videoConfigSchema.optional(),
  port: z.number().default(8788),
  host: z.string().default("127.0.0.1"),
  logDir: z.string().default(""),
  failover: z.boolean().default(true),
  requestTimeoutMs: z.number().positive().default(30000),
  routingStrategy: z.enum(["priority", "round-robin", "weighted-round-robin", "fill-first", "latency"]).default("priority"),
  sessionAffinity: sessionAffinitySchema,
  visionFallbackModel: z.string().default(""),
  providers: providersSchema,
  hostConfig: hostConfigSchema,
});

/**
 * Validate an unknown raw config object and return a fully-formed `ShimConfig`.
 *
 * Throws a `ZodError` (via `schema.parse`) when the input does not conform.
 */
export function parseConfig(raw: unknown): ShimConfig {
  return shimConfigSchema.parse(raw) as ShimConfig;
}
