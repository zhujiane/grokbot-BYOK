/** Grok video generation: native xAI REST and an OpenAI-style adapter. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { videoConfigSchema } from "../config/schema.js";
import type { Logger, VideoConfig } from "../types.js";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = "invalid_request") {
    super(message);
  }
}

const media = z.object({ url: z.string().min(1) }).passthrough();
const nativeRequest = z.object({
  model: z.string().min(1),
  prompt: z.string().trim().min(1).max(32000),
  duration: z.number().int().min(1).max(15).optional(),
  aspect_ratio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]).optional(),
  resolution: z.enum(["480p", "720p", "1080p"]).optional(),
  image: media.optional(),
  video: media.optional(),
}).passthrough(); // Forward newer xAI generation options without dropping them.

const openaiRequest = z.object({
  model: z.string().min(1),
  prompt: z.string().trim().min(1).max(32000),
  seconds: z.enum(["4", "8", "12"]).default("4"),
  size: z.enum(["1280x720", "720x1280"]).default("720x1280"),
  input_reference: z.object({ image_url: z.string().min(1) }).strict().optional(),
}).strict();

interface Job {
  id: string;
  request_id: string;
  created_at: number;
  model: string;
  prompt: string;
  seconds: string;
  size: string;
}

const resultSchema = z.object({
  status: z.enum(["pending", "done", "failed", "expired"]),
  video: z.object({ url: z.string().url(), duration: z.number().optional() }).passthrough().optional(),
  progress: z.number().min(0).max(100).optional(),
}).passthrough();

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

export async function body(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, "Video request body exceeds maxBodyBytes", "body_too_large");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  const type = req.headers["content-type"] ?? "";
  if (type.startsWith("multipart/form-data")) {
    // Supports OpenAI SDKs that submit a file as input_reference.
    const form = await new Response(bytes, { headers: { "Content-Type": type } }).formData();
    const out: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      if (key in out) throw new ApiError(400, `Duplicate field: ${key}`);
      if (typeof value === "string") out[key] = value;
      else if (key === "input_reference") {
        if (!["image/jpeg", "image/png", "image/webp"].includes(value.type)) {
          throw new ApiError(400, "input_reference must be JPEG, PNG or WebP");
        }
        out[key] = { image_url: `data:${value.type};base64,${Buffer.from(await value.arrayBuffer()).toString("base64")}` };
      } else throw new ApiError(400, `Unexpected file field: ${key}`);
    }
    return out;
  }
  if (!type.startsWith("application/json")) throw new ApiError(415, "Use application/json or multipart/form-data");
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "Expected a JSON object");
  return parsed;
}

export function createVideoHandler(raw: VideoConfig | undefined, logger: Logger) {
  const config = videoConfigSchema.parse(raw ?? {});
  const jobsDir = path.resolve(config.jobsDir);
  const localId = /^video_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  async function upstream(endpoint: string, payload?: unknown): Promise<unknown> {
    // No automatic POST retry: a timeout may already have created a billable job.
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${endpoint}`, {
      method: payload === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
      redirect: "error",
    });
    if (!response.ok) {
      // Do not relay upstream bodies: they may echo credentials or large media.
      await response.body?.cancel();
      throw new ApiError([400, 404, 422, 429].includes(response.status) ? response.status : 502,
        `xAI video API returned HTTP ${response.status}`, "upstream_error");
    }
    try { return await response.json(); }
    catch (error) {
      if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw error;
      throw new ApiError(502, "xAI returned an invalid JSON response", "upstream_error");
    }
  }

  async function loadJob(id: string): Promise<Job> {
    try {
      return JSON.parse(await readFile(path.join(jobsDir, `${id}.json`), "utf8")) as Job;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ApiError(404, "Video job not found", "not_found");
      throw error;
    }
  }

  function view(job: Job, result?: z.infer<typeof resultSchema>) {
    const status = !result ? "queued" : result.status === "pending" ? "in_progress"
      : result.status === "done" ? "completed" : "failed";
    return {
      id: job.id, object: "video", model: job.model, prompt: job.prompt,
      created_at: job.created_at, seconds: job.seconds, size: job.size,
      status, progress: status === "completed" ? 100 : result?.progress ?? 0,
      error: status === "failed" ? { code: result!.status, message: `xAI video generation ${result!.status}` } : null,
      // Extension for callers who prefer the temporary xAI URL to /content.
      ...(result?.video ? { video: result.video } : {}),
    };
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/v1/videos" && !url.pathname.startsWith("/v1/videos/")) return false;
    if (!config.enabled) {
      json(res, 503, { error: { message: "Video API is disabled", type: "service_unavailable", code: "video_disabled" } });
      return true;
    }
    try {
      const expected = Buffer.from(`Bearer ${config.apiToken}`);
      const received = Buffer.from(req.headers.authorization ?? "");
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        throw new ApiError(401, "Invalid video API token", "unauthorized");
      }
      const route = url.pathname;
      const nativeCreate = ["/v1/videos/generations", "/v1/videos/edits", "/v1/videos/extensions"].includes(route);
      if (req.method === "POST" && (route === "/v1/videos" || nativeCreate)) {
        const input = await body(req, config.maxBodyBytes);
        input.model ??= config.defaultModel;
        if (typeof input.model !== "string" || !/^grok-imagine-video(?:-[\w.-]+)?$/.test(input.model)) {
          throw new ApiError(400, "This backend supports grok-imagine-video models; Sora models are not mapped to Grok");
        }
        if (nativeCreate) {
          const parsed = nativeRequest.parse(input);
          if (route !== "/v1/videos/generations" && !parsed.video) throw new ApiError(400, "video.url is required");
          const result = await upstream(route.slice(3), parsed);
          const checked = z.object({ request_id: z.string().min(1) }).passthrough().safeParse(result);
          if (!checked.success) throw new ApiError(502, "xAI did not return a request_id", "upstream_error");
          json(res, 200, checked.data);
        } else {
          const parsed = openaiRequest.parse(input);
          // Prepare persistence before creating a potentially billable job.
          await mkdir(jobsDir, { recursive: true, mode: 0o700 });
          const id = `video_${randomUUID()}`;
          const filename = path.join(jobsDir, `${id}.json`);
          await writeFile(`${filename}.tmp`, "{}", { mode: 0o600, flag: "wx" });
          let result: unknown;
          try {
            result = await upstream("/videos/generations", {
            model: parsed.model, prompt: parsed.prompt, duration: Number(parsed.seconds),
            aspect_ratio: parsed.size === "1280x720" ? "16:9" : "9:16", resolution: "720p",
            ...(parsed.input_reference ? { image: { url: parsed.input_reference.image_url } } : {}),
            });
          } catch (error) {
            await unlink(`${filename}.tmp`).catch(() => {});
            throw error;
          }
          const checked = z.object({ request_id: z.string().min(1) }).safeParse(result);
          if (!checked.success) {
            await unlink(`${filename}.tmp`).catch(() => {});
            throw new ApiError(502, "xAI did not return a request_id", "upstream_error");
          }
          const job: Job = { id, request_id: checked.data.request_id, created_at: Math.floor(Date.now() / 1000),
            model: parsed.model, prompt: parsed.prompt, seconds: parsed.seconds, size: parsed.size };
          try {
            await writeFile(`${filename}.tmp`, JSON.stringify(job), { mode: 0o600 });
            await rename(`${filename}.tmp`, filename);
          } catch {
            // Preserve the upstream ID so an accepted task remains recoverable.
            logger.error("failed to persist accepted video job", { id, request_id: job.request_id });
            json(res, 500, { error: { code: "job_persistence_error", message: "Job accepted by xAI but could not be saved; query using request_id", request_id: job.request_id } });
            return true;
          }
          json(res, 200, view(job));
        }
        return true;
      }

      const match = /^\/v1\/videos\/([A-Za-z0-9_-]+)(\/content)?$/.exec(route);
      if (req.method !== "GET" || !match || nativeCreate) throw new ApiError(404, "Video endpoint not found", "not_found");
      const id = match[1];
      const job = localId.test(id) ? await loadJob(id) : undefined;
      const result = resultSchema.safeParse(await upstream(`/videos/${encodeURIComponent(job?.request_id ?? id)}`));
      if (!result.success) throw new ApiError(502, "xAI returned an invalid video result", "upstream_error");
      if (!match[2]) {
        json(res, 200, job ? view(job, result.data) : result.data);
        return true;
      }
      if (url.searchParams.get("variant") && url.searchParams.get("variant") !== "video") {
        throw new ApiError(400, "Only variant=video is supported");
      }
      if (result.data.status !== "done") throw new ApiError(409, `Video is ${result.data.status}`, "video_not_ready");
      if (!result.data.video) throw new ApiError(502, "xAI completed without a video URL", "upstream_error");
      const downloadUrl = new URL(result.data.video.url);
      if (downloadUrl.protocol !== "https:" || downloadUrl.username || downloadUrl.password) {
        throw new ApiError(502, "xAI returned an invalid download URL", "upstream_error");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
      const cancel = () => { if (!res.writableEnded) controller.abort(); };
      res.on("close", cancel);
      try {
        // Never forward either API credential to the media host.
        const download = await fetch(downloadUrl, { signal: controller.signal });
        if (!download.ok || !download.body) {
          await download.body?.cancel();
          throw new ApiError(502, "Unable to download generated video", "upstream_error");
        }
        res.writeHead(200, { "Content-Type": "video/mp4", "Cache-Control": "no-store" });
        await pipeline(Readable.fromWeb(download.body as import("node:stream/web").ReadableStream), res);
      } finally {
        clearTimeout(timer);
        res.off("close", cancel);
      }
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return true; }
      const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
      const status = error instanceof ApiError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : timeout ? 504 : 502;
      const message = error instanceof ApiError ? error.message : error instanceof z.ZodError ? error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")
        : error instanceof SyntaxError ? "Malformed request body" : timeout ? "Video upstream timed out; creation outcome may be unknown. Do not blindly retry." : "Video request failed";
      json(res, status, { error: { message, type: status < 500 ? "invalid_request_error" : "api_error",
        code: error instanceof ApiError ? error.code : timeout ? "upstream_timeout" : "video_error" } });
    }
    return true;
  };
}
