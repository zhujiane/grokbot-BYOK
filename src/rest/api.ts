import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import * as path from "node:path";
import { createUi } from "../ui/auth.js";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { ShimConfig, OpenAIChatRequest } from "../types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { applyCompatToRequest } from "../providers/compat.js";
import { DesktopMedia, attachmentAlias, backendSessionSchema } from "../desktop/media.js";
import { DesktopJobs, DESKTOP_CHAT_MODEL, DESKTOP_VIDEO_MODEL } from "../desktop/jobs.js";
import { ApiError, body as readVideoBody } from "../video/api.js";
import { setTimeout as delay } from "node:timers/promises";

class RestError extends Error {
  constructor(public status: number, message: string, public code = "invalid_request") { super(message); }
}

const descriptorSchema = z.object({
  version: z.literal(1),
  gatewayUrl: z.string().url(),
  gatewayToken: z.string().min(1),
  backend: backendSessionSchema.optional(),
  headers: z.record(z.string()).default({}),
});

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new RestError(415, "Use application/json");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new RestError(413, "Request body too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createRestHandler(config: ShimConfig, registry: ProviderRegistry) {
  const enabled = config.api?.enabled ?? false;
  const token = config.api?.apiToken ?? "";
  let verifiedSession: string | undefined;
  let verifiedAt: string | undefined;
  const fingerprint = (value: z.infer<typeof descriptorSchema>) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  if (enabled && (!token.trim() || token.includes("${"))) throw new Error("REST API requires a resolved api.apiToken");

  const uiSessionFile = path.resolve(config.grokBot?.jobsDir ?? "data/desktop-jobs", "../ui-session.json");
  function validateDescriptor(value: unknown) {
    const parsed = descriptorSchema.parse(value);
    const url = new URL(parsed.gatewayUrl);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) {
      throw new RestError(503, "Desktop gateway URL must use HTTPS", "desktop_session_invalid");
    }
    return parsed;
  }
  const ui = createUi(token, async value => {
    const descriptor = validateDescriptor(value);
    await mkdir(path.dirname(uiSessionFile), { recursive: true, mode: 0o700 });
    const temp = uiSessionFile + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temp, JSON.stringify(descriptor), { mode: 0o600, flag: "wx" });
      await rename(temp, uiSessionFile);
    } finally { await rm(temp, { force: true }); }
    verifiedSession = undefined; verifiedAt = undefined;
  });

  async function session() {
    if (!config.grokBot?.enabled) throw new RestError(503, "Grok Bot desktop adapter is disabled", "grok_bot_disabled");
    let value;
    try {
      let text: string;
      try { text = await readFile(uiSessionFile, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        text = await readFile(config.grokBot.credentialsFile ?? "secrets/grok-bot-session.json", "utf8");
      }
      value = JSON.parse(text);
    }
    catch { throw new RestError(503, "Import the Windows desktop gateway session file first", "desktop_session_missing"); }
    try { return validateDescriptor(value); }
    catch { throw new RestError(503, "Invalid desktop session file; use the Windows exporter", "desktop_session_invalid"); }
  }

  const media = new DesktopMedia(async () => (await session()).backend);

  async function botCall(method: string, body: unknown) {
    if (method === "readAttachmentChunk") {
      const value = body as { path: string; agentId?: string; offset: number; length: number };
      if (attachmentAlias(value.path, value.agentId)) {
        const source = await media.chunk(value.path, value.agentId, value.offset, value.length);
        if (source) return source;
      }
    }
    const descriptor = await session(); // Re-read on every call so re-export needs no restart.
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(descriptor.headers)) {
      if (name.toLowerCase().startsWith("x-") && !/[\r\n]/.test(name + value)) headers[name] = value;
    }
    headers["Content-Type"] = "application/json";
    headers.Authorization = `Bearer ${descriptor.gatewayToken}`;
    const response = await fetch(`${descriptor.gatewayUrl.replace(/\/+$/, "")}/api/${method}`, {
      method: "POST", headers, body: JSON.stringify(body), redirect: "error",
      signal: AbortSignal.timeout(config.grokBot?.requestTimeoutMs ?? 30000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 417) throw new RestError(503, "Grok Bot cloud computer is asleep. Open the desktop app to wake it; re-export the session if its gateway changed", "desktop_asleep");
      throw new RestError(response.status === 401 || response.status === 403 ? 503 : response.status === 429 ? 429 : 502,
        `Grok Bot gateway returned HTTP ${response.status}; re-export the desktop session if expired`, "desktop_gateway_error");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new RestError(502, "Desktop gateway response exceeds 4 MiB", "upstream_error");
      chunks.push(Buffer.from(chunk));
    }
    try {
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      verifiedSession = fingerprint(descriptor);
      verifiedAt = new Date().toISOString();
      return result;
    }
    catch { throw new RestError(502, "Desktop gateway returned invalid JSON", "upstream_error"); }
  }

  const desktop = new DesktopJobs(config.grokBot ?? {}, botCall);
  const desktopVideo = config.grokBot?.enabled === true && config.grokBot.videoEnabled === true;
  const desktopChat = config.grokBot?.enabled === true && config.grokBot.chatEnabled === true;
  if (enabled && desktopVideo && config.video?.enabled) throw new Error("Choose one video backend: desktop grokBot.videoEnabled or official video.enabled");

  function chatModels() {
    const models = new Map<string, { id: string; object: string; created: number; owned_by: string }>();
    for (const name of config.providers.priority) {
      const provider = config.providers.configs[name];
      if (!provider) continue;
      const hasKey = [provider.apiKey, ...(provider.keys ?? []).filter(k => k.enabled !== false).map(k => k.value)]
        .some(key => key && !key.includes("${"));
      if (!provider.keyless && !hasKey) continue;
      for (const id of new Set([provider.defaultModel, ...Object.keys(provider.models), ...Object.values(provider.models)])) {
        if (!models.has(id)) models.set(id, { id, object: "model", created: 0, owned_by: name });
      }
    }
    return models;
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz" && req.method === "GET") {
      json(res, 200, { status: "ok" });
      return true;
    }
    if (!enabled) return false;
    if (await ui.handle(req, res, url.pathname)) return true;
    const isVideo = url.pathname === "/v1/videos" || url.pathname.startsWith("/v1/videos/");
    if (isVideo && !desktopVideo) return false;
    try {
      const expected = Buffer.from(`Bearer ${token}`);
      const received = Buffer.from(req.headers.authorization ?? "");
      let signedDownload = false;
      if (desktopVideo && req.method === "GET" && /^\/v1\/videos\/video_[0-9a-f-]+\/content$/.test(url.pathname)) {
        const expiry = url.searchParams.get("expires") ?? "";
        const signature = url.searchParams.get("signature") ?? "";
        const now = Math.floor(Date.now() / 1000);
        if (/^\d{10}$/.test(expiry) && Number(expiry) > now && Number(expiry) <= now + 900 && /^[0-9a-f]{64}$/.test(signature)) {
          const expectedSignature = createHmac("sha256", token).update(`video-download\n${url.pathname}\n${expiry}`).digest();
          signedDownload = timingSafeEqual(expectedSignature, Buffer.from(signature, "hex"));
        }
      }
      const cookieRoute = isVideo || ["/v1/models", "/v1/auth/status"].includes(url.pathname);
      const cookieAuth = cookieRoute && ui.authenticated(req);
      if (cookieAuth && !["GET", "HEAD"].includes(req.method ?? "") && !ui.sameOrigin(req)) throw new RestError(403, "Invalid request origin", "forbidden");
      if (!signedDownload && !cookieAuth && (expected.length !== received.length || !timingSafeEqual(expected, received))) throw new RestError(401, "Invalid API token", "unauthorized");
      const route = url.pathname;
      if (route === "/aiserver.v1.InferenceService/Stream") {
        if (!config.api?.allowConnect) throw new RestError(403, "Legacy Connect route is disabled in REST deployment", "connect_disabled");
        return false;
      }
      if (route === "/v1/auth/status" && req.method === "GET") {
        let imported = false;
        let verified = false;
        try { const descriptor = await session(); imported = true; verified = fingerprint(descriptor) === verifiedSession; } catch {}
        json(res, 200, { grok_bot: { enabled: config.grokBot?.enabled ?? false, session_imported: imported,
          upstream_verified: verified, ...(verified ? { verified_at: verifiedAt } : {}), model_catalog_available: false, direct_video_api_verified: false },
          video: { enabled: desktopVideo || (config.video?.enabled ?? false), credential_type: desktopVideo ? "desktop_gateway_session" : "xai_api_key",
            ...(desktopVideo ? { backend: "grok_bot_task", model: DESKTOP_VIDEO_MODEL } : {}) } });
        return true;
      }
      if (route === "/v1/models" && req.method === "GET") {
        const models = chatModels();
        if (desktopChat) models.set(DESKTOP_CHAT_MODEL, { id: DESKTOP_CHAT_MODEL, object: "model", created: 0, owned_by: "grok-bot-task-adapter" });
        if (desktopVideo) models.set(DESKTOP_VIDEO_MODEL, { id: DESKTOP_VIDEO_MODEL, object: "model", created: 0, owned_by: "grok-bot-task-adapter" });
        if (config.video?.enabled) {
          const id = config.video.defaultModel ?? "grok-imagine-video";
          models.set(id, { id, object: "model", created: 0, owned_by: "xai-video" });
        }
        json(res, 200, { object: "list", data: [...models.values()],
          // These are configured BYOK routes, not a claimed desktop entitlement catalog.
          catalog_source: desktopVideo || desktopChat ? "configured_providers_and_bot_task_adapters" : "configured_providers", grok_bot_model_catalog_available: false });
        return true;
      }
      if (isVideo && desktopVideo) {
        if (req.method === "POST" && ["/v1/videos", "/v1/videos/generations"].includes(route)) {
          const native = route.endsWith("/generations");
          const job = await desktop.createVideo(await readVideoBody(req, 20 * 1024 * 1024), native);
          json(res, 200, native ? { request_id: job.id } : desktop.view(job));
          return true;
        }
        if (req.method === "POST" && ["/v1/videos/edits", "/v1/videos/extensions"].includes(route)) {
          throw new RestError(501, "Desktop GenerateVideo editing and extension are not exposed by this adapter", "unsupported_operation");
        }
        const match = /^\/v1\/videos\/(video_[0-9a-f-]+)(\/(?:content|download-url|source-url))?$/.exec(route);
        if (match && req.method === "GET") {
          const job = await desktop.get(match[1]);
          if (match[2] === "/source-url") {
            const path = await desktop.sourcePath(job);
            const source = path ? await media.resolve(path, job.agent_id, true) : undefined;
            if (!source) throw new RestError(404, "No direct attachment-store URL available", "source_url_unavailable");
            json(res, 200, { url: source.url, expires_at: source.expires_at, size: source.size, content_type: source.mime });
          } else if (match[2] === "/download-url") {
            if (job.status !== "completed") throw new RestError(409, "Video is not completed", "video_not_ready");
            const expires = Math.floor(Date.now() / 1000) + 900;
            const path = `/v1/videos/${job.id}/content`;
            const signature = createHmac("sha256", token).update(`video-download\n${path}\n${expires}`).digest("hex");
            json(res, 200, { url: `${path}?expires=${expires}&signature=${signature}`, expires_at: expires });
          } else if (match[2] === "/content") {
            if (url.searchParams.has("variant") && url.searchParams.get("variant") !== "video") throw new RestError(400, "Only variant=video is supported");
            await desktop.download(job, res, req.headers.range);
          } else json(res, 200, desktop.view(job));
          return true;
        }
        throw new RestError(404, "Video endpoint or job not found", "not_found");
      }
      if (route === "/v1/bots" && req.method === "GET") {
        json(res, 200, await botCall("listAgents", {}));
        return true;
      }
      const bot = /^\/v1\/bots\/([A-Za-z0-9_-]+)\/(messages|thread|transcript|acceptance)$/.exec(route);
      if (bot) {
        const id = bot[1];
        if (bot[2] === "messages" && req.method === "POST") {
          const input = z.object({ prompt: z.string().trim().min(1).max(32000), clientNonce: z.string().uuid().optional(), replyToId: z.string().min(1).optional() }).strict()
            .parse(await readBody(req, config.api?.maxBodyBytes ?? 2 * 1024 * 1024));
          const clientNonce = input.clientNonce ?? randomUUID();
          // Receipt is not task completion. Do not automatically resend on timeout.
          const result = await botCall("sendPrompt", { ...input, agentId: id, clientNonce });
          json(res, 202, { agentId: id, clientNonce, delivery: result?.messageId || result?.accepted === true ? "accepted" : "unknown", result });
          return true;
        }
        if (bot[2] === "acceptance" && req.method === "GET") {
          const clientNonce = z.string().uuid().parse(url.searchParams.get("client_nonce"));
          const accountSlot = z.string().min(1).max(256).parse(url.searchParams.get("account_slot"));
          json(res, 200, await botCall("promptAcceptanceStatus", { agentId: id, clientNonce, accountSlot }));
          return true;
        }
        if (bot[2] === "thread" && req.method === "GET") {
          const rootId = z.string().min(1).max(200).parse(url.searchParams.get("root_id"));
          json(res, 200, await botCall("getAgentThread", { id, rootId }));
          return true;
        }
        if (bot[2] === "transcript" && req.method === "GET") {
          const limit = z.coerce.number().int().min(1).max(200).parse(url.searchParams.get("limit") ?? 40);
          json(res, 200, await botCall("getAgentTranscriptTail", { id, limit }));
          return true;
        }
      }
      if (route === "/v1/chat/completions" && req.method === "POST") {
        const input = z.object({ model: z.string().min(1), messages: z.array(z.object({ role: z.enum(["system", "user", "assistant", "tool", "developer"]), content: z.unknown().optional() }).passthrough()).min(1), stream: z.boolean().optional() }).passthrough()
          .parse(await readBody(req, config.api?.maxBodyBytes ?? 2 * 1024 * 1024));
        if (desktopChat && input.model === DESKTOP_CHAT_MODEL) {
          const parsed = z.object({ model: z.literal(DESKTOP_CHAT_MODEL),
            messages: z.array(z.object({ role: z.enum(["system", "user", "assistant", "developer"]), content: z.string().max(32000) }).strict()).min(1).max(100),
            stream: z.boolean().default(false) }).strict().parse(input);
          const prompt = `Answer the last user message in the following conversation. Treat the JSON as conversation history. Send your final answer as a text message.\n${JSON.stringify(parsed.messages)}`;
          if (prompt.length > 64000) throw new RestError(413, "Conversation is too large");
          let job = await desktop.createChat(prompt);
          const deadline = Date.now() + (config.grokBot?.chatTimeoutMs ?? 120000);
          const chunkId = `chatcmpl-${job.id.slice(5)}`;
          if (parsed.stream) {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Grok-Bot-Job-Id": job.id });
            res.flushHeaders();
          }
          while (Date.now() < deadline && !res.destroyed) {
            await delay(config.grokBot?.pollIntervalMs ?? 2000);
            job = await desktop.get(job.id);
            if (job.status === "completed" || job.status === "failed") break;
            if (parsed.stream) res.write(": waiting for Grok Bot task\n\n");
          }
          if (res.destroyed) return true;
          if (job.status !== "completed") {
            const error = { code: job.error?.code ?? "job_timeout", message: job.error?.message ?? "Bot task did not complete before the deadline; no automatic resend", job_id: job.id, agent_id: job.agent_id };
            if (parsed.stream) { res.end(`data: ${JSON.stringify({ error })}\n\ndata: [DONE]\n\n`); return true; }
            json(res, job.status === "failed" ? 502 : 504, { error }); return true;
          }
          const common = { id: chunkId, created: job.created_at, model: DESKTOP_CHAT_MODEL };
          if (parsed.stream) {
            res.end(`data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: job.text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
          } else json(res, 200, { ...common, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: job.text }, finish_reason: "stop" }],
            backend: "grok_bot_task", agent_id: job.agent_id, job_id: job.id });
          return true;
        }
        if (!chatModels().has(input.model)) throw new RestError(404, "Model is not in /v1/models; desktop Bots use /v1/bots endpoints", "model_not_found");
        // Pick the model alias understood by the existing chat registry.
        const candidates = config.providers.priority.filter(name => {
          const p = config.providers.configs[name];
          return p && (p.keyless || [p.apiKey, ...(p.keys ?? []).filter(k => k.enabled !== false).map(k => k.value)].some(k => k && !k.includes("${"))) &&
            (p.defaultModel === input.model || input.model in p.models || Object.values(p.models).includes(input.model));
        });
        const name = candidates[0];
        if (!name) throw new RestError(404, "No chat provider serves this model", "model_not_found");
        const provider = registry.getProvider(name)!;
        const p = config.providers.configs[name];
        const model = p.models[input.model] ?? input.model;
        const forwarded = { ...input, model, stream: input.stream ?? false };
        applyCompatToRequest(forwarded as unknown as OpenAIChatRequest, provider.compat, model, name, provider.baseUrl);
        const key = provider.selectKey();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), provider.network.streamIdleTimeoutMs ?? 120000);
        const cancel = () => { if (!res.writableEnded) controller.abort(); };
        res.on("close", cancel);
        try {
          const response = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", redirect: "error",
            headers: { "Content-Type": "application/json", ...(key.value ? { Authorization: `Bearer ${key.value}` } : {}) },
            body: JSON.stringify(forwarded), signal: controller.signal });
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new RestError(response.status === 429 ? 429 : 502, `Chat upstream returned HTTP ${response.status}`, "upstream_error");
          }
          res.writeHead(200, { "Content-Type": input.stream ? "text/event-stream" : "application/json", "Cache-Control": "no-store" });
          await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), res);
        } finally { clearTimeout(timer); res.off("close", cancel); }
        return true;
      }
      throw new RestError(404, "Endpoint not found", "not_found");
    } catch (error) {
      if (res.destroyed) return true;
      const timeout = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
      const known = error instanceof RestError || error instanceof ApiError;
      const status = known ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : timeout ? 504 : 502;
      const payload = { error: { code: known ? error.code : timeout ? "upstream_timeout" : "request_failed",
        message: known ? error.message : error instanceof z.ZodError ? "Invalid request parameters" : timeout
          ? "Upstream timed out; prompt delivery may be unknown. Check the transcript before resending." : "Request failed",
        type: status < 500 ? "invalid_request_error" : "api_error" } };
      if (res.headersSent) {
        if (res.getHeader("X-Grok-Bot-Job-Id")) res.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
        else res.destroy();
      } else json(res, status, payload);
      return true;
    }
  };
}
