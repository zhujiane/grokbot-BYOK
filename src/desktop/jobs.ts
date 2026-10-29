/** Desktop 0.77 gateway adapter. This runs Bot tasks, not raw model inference. */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { ShimConfig } from "../types.js";
import { ApiError } from "../video/api.js";

export const DESKTOP_VIDEO_MODEL = "grok-bot-video";
export const DESKTOP_CHAT_MODEL = "grok-bot";
export type BotCall = (method: string, body: unknown) => Promise<any>;
const record = z.object({}).passthrough();
const page = z.object({ entries: z.array(record), nextBeforeSeq: z.number().optional() });
const idPattern = /^(?:video|chat)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const videoPath = (value: unknown): value is string => typeof value === "string" && /\.mp4(?:[?#]|$)/i.test(value);

export interface DesktopJob {
  version: 1;
  id: string;
  kind: "video" | "chat";
  format: "openai" | "xai";
  model: string;
  created_at: number;
  prompt: string;
  seconds: string;
  size: string;
  duration: number;
  aspect_ratio: string;
  resolution: string;
  phase: "creating" | "uploading" | "sending" | "submitted";
  status: "queued" | "in_progress" | "completed" | "failed";
  clientNonce: string;
  agent_id?: string;
  output_path?: string;
  recovery_nonce?: string; // Legacy records only; no new follow-up prompts are sent.
  text?: string;
  delivery?: "accepted" | "unknown";
  completed_at?: number;
  generation_tool_verified?: boolean;
  settled_without_output_at?: number;
  error?: { code: string; message: string };
}

const imageUrl = z.string().min(1).max(16 * 1024 * 1024);
// Adapter extensions shared by both request formats; these are not official API fields.
const imageInput = z.object({ url: imageUrl }).strict();
const imageOptions = {
  reference_images: z.array(imageInput).min(1).max(8).optional(),
  last_frame: imageInput.optional(),
  keyframes: z.array(z.object({ url: imageUrl, timestamp_seconds: z.number().finite().min(0) }).strict()).min(1).max(16).optional(),
};
interface VideoImages {
  image?: string;
  reference_images?: { url: string }[];
  last_frame?: { url: string };
  keyframes?: { url: string; timestamp_seconds: number }[];
}
const openaiInput = z.object({
  model: z.literal(DESKTOP_VIDEO_MODEL).default(DESKTOP_VIDEO_MODEL),
  prompt: z.string().trim().min(1).max(32000),
  seconds: z.enum(["4", "8", "12"]).default("4"),
  size: z.enum(["1280x720", "720x1280"]).default("1280x720"),
  input_reference: z.object({ image_url: imageUrl }).strict().optional(),
  ...imageOptions,
}).strict();
const nativeInput = z.object({
  model: z.literal(DESKTOP_VIDEO_MODEL).default(DESKTOP_VIDEO_MODEL),
  prompt: z.string().trim().min(1).max(32000),
  duration: z.number().int().min(1).max(15).default(4),
  aspect_ratio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]).default("16:9"),
  resolution: z.enum(["480p", "720p", "1080p"]).default("720p"),
  image: imageInput.optional(),
  ...imageOptions,
}).strict();

export function parseDesktopVideo(input: unknown, native: boolean) {
  if (native) {
    const value = nativeInput.parse(input);
    return { prompt: value.prompt, seconds: String(value.duration), size: value.aspect_ratio === "9:16" ? "720x1280" : "1280x720",
      duration: value.duration, aspect_ratio: value.aspect_ratio, resolution: value.resolution, image: value.image?.url,
      reference_images: value.reference_images, last_frame: value.last_frame, keyframes: value.keyframes };
  }
  const value = openaiInput.parse(input);
  return { prompt: value.prompt, seconds: value.seconds, size: value.size, duration: Number(value.seconds),
    aspect_ratio: value.size === "720x1280" ? "9:16" : "16:9", resolution: "720p", image: value.input_reference?.image_url,
    reference_images: value.reference_images, last_frame: value.last_frame, keyframes: value.keyframes };
}

function validateImage(image?: string) {
  if (!image) return;
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) return;
  try {
    const url = new URL(image);
    if (url.protocol === "https:" && !url.username && !url.password) return;
  } catch {}
  throw new ApiError(400, "Reference image must be an HTTPS URL or a PNG/JPEG/WebP base64 data URL");
}

export class DesktopJobs {
  private active = new Map<string, Promise<void>>();
  private starting = 0;
  private polls = new Map<string, Promise<DesktopJob>>();
  private dir: string;
  constructor(private config: NonNullable<ShimConfig["grokBot"]>, private call: BotCall) {
    this.dir = path.resolve(config.jobsDir ?? "data/desktop-jobs");
  }
  private filename(id: string) {
    if (!idPattern.test(id)) throw new ApiError(404, "Desktop job not found", "not_found");
    return path.join(this.dir, `${id}.json`);
  }
  private async save(job: DesktopJob) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const filename = this.filename(job.id);
    const temp = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(job), { mode: 0o600, flag: "wx" });
    await rename(temp, filename);
  }
  private async load(id: string): Promise<DesktopJob> {
    const filename = this.filename(id);
    let job: DesktopJob;
    try { job = JSON.parse(await readFile(filename, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ApiError(404, "Desktop job not found", "not_found");
      throw error;
    }
    if (job.version !== 1 || job.id !== id) throw new ApiError(502, "Invalid desktop job record", "job_invalid");
    return job;
  }
  private fail(job: DesktopJob, code: string, message: string) {
    job.status = "failed";
    job.error = { code, message };
  }

  async createVideo(input: unknown, native: boolean) {
    const { image, reference_images, last_frame, keyframes, ...value } = parseDesktopVideo(input, native);
    for (const url of [image, last_frame?.url, ...(reference_images ?? []).map(i => i.url), ...(keyframes ?? []).map(i => i.url)]) validateImage(url);
    const times = (keyframes ?? []).map(frame => frame.timestamp_seconds);
    if (times.some(time => time > value.duration) || new Set(times).size !== times.length) {
      throw new ApiError(400, "Keyframe timestamps must be unique and within the requested video duration");
    }
    return this.create({ ...value, kind: "video", format: native ? "xai" : "openai", model: DESKTOP_VIDEO_MODEL },
      { image, reference_images, last_frame, keyframes });
  }
  async createChat(prompt: string) {
    return this.create({ kind: "chat", format: "openai", model: DESKTOP_CHAT_MODEL, prompt,
      duration: 0, aspect_ratio: "", resolution: "", seconds: "0", size: "" });
  }
  private async create(value: Pick<DesktopJob, "kind" | "format" | "model" | "prompt" | "duration" | "aspect_ratio" | "resolution" | "seconds" | "size">, images?: VideoImages) {
    if (this.active.size + this.starting >= (this.config.maxConcurrentJobs ?? 4)) throw new ApiError(429, "Too many desktop task submissions; retry later", "rate_limit_exceeded");
    this.starting++;
    try {
      // Verify the session is awake before returning an asynchronous receipt. No mutation here.
      await this.call("listAgents", {});
      const job: DesktopJob = { version: 1, id: `${value.kind}_${randomUUID()}`, ...value,
        created_at: Math.floor(Date.now() / 1000), phase: "creating", status: "queued", clientNonce: randomUUID() };
      await this.save(job);
      // A submission is never replayed automatically, including after restart.
      const work = this.submit(job, images).catch(async () => {
        this.fail(job, "submission_uncertain", "Submission was interrupted and may have reached the Bot. Inspect agent_id before starting another job.");
        await this.save(job);
      }).catch(() => { /* A storage failure must not cause an unhandled worker rejection. */ })
        .finally(() => this.active.delete(job.id));
      this.active.set(job.id, work);
      // Snapshot: the worker may already be updating its own copy.
      return { ...job };
    } finally { this.starting--; }
  }
  private async submit(job: DesktopJob, images: VideoImages = {}) {
    const result = await this.call("createAgent", {
      name: `API ${job.kind} ${job.id.slice(-8)}`,
      description: job.kind === "video" ? "Generate videos using the built-in GenerateVideo tool and send the resulting MP4 as an attachment."
        : "Answer the supplied conversation. Send the final answer as a text message.",
      isIntroductionSuppressed: true, isKickstartRequested: false, supportsTemporalHarness: true,
      clientNonce: job.id,
    });
    const agent = z.object({ agent: z.object({ id: z.string().min(1).max(256).refine(id => id === id.trim() && !/[\/\\\0]/.test(id) && id !== "." && id !== "..") }) }).parse(result).agent;
    job.agent_id = agent.id;
    job.phase = "uploading";
    await this.save(job);
    const attachments: string[] = [];
    const instructions: string[] = [];
    let imageIndex = 0;
    const prepareImage = async (image: string): Promise<string> => {
      const index = imageIndex++;
      if (!image.startsWith("data:")) {
        const local = `/tmp/grokbot-${job.id}-image-${index}`;
        instructions.push(`Download the image from ${JSON.stringify(image)} to ${JSON.stringify(local)} before calling GenerateVideo. Use the downloaded file path, never the URL, as the tool argument.`);
        return local;
      }
      const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(image)!;
      const uploaded = z.object({ path: z.string().min(1) }).parse(await this.call("uploadAttachment", {
        agentId: agent.id, filename: `${index === 0 ? "reference" : `reference-${index}`}.${match[1] === "jpeg" ? "jpg" : match[1]}`, bytesBase64: match[2],
      }));
      attachments.push(uploaded.path);
      return uploaded.path;
    };
    const imageParameters: Record<string, unknown> = {};
    if (images.image) imageParameters.image_path = await prepareImage(images.image);
    if (images.reference_images) {
      const paths: string[] = [];
      for (const image of images.reference_images) paths.push(await prepareImage(image.url));
      imageParameters.reference_image_paths = paths;
    }
    if (images.last_frame) imageParameters.last_frame_path = await prepareImage(images.last_frame.url);
    if (images.keyframes) {
      const frames = [];
      for (const frame of [...images.keyframes].sort((a, b) => a.timestamp_seconds - b.timestamp_seconds)) {
        frames.push({ image_path: await prepareImage(frame.url), timestamp_seconds: frame.timestamp_seconds });
      }
      imageParameters.keyframes = frames;
    }
    const prompt = job.kind === "video" ? [
      "Generate exactly one MP4 video using your built-in GenerateVideo tool. Do not substitute stock footage, code-generated animation, or another service.",
      `Tool parameters requested: duration_seconds=${job.duration}, aspect_ratio=${JSON.stringify(job.aspect_ratio)}, resolution=${JSON.stringify(job.resolution)}, file_path=${JSON.stringify(`/tmp/grokbot-${job.id}.mp4`)}.`,
      ...instructions,
      ...(Object.keys(imageParameters).length ? [
        `Use these exact image arguments for GenerateVideo: ${JSON.stringify(imageParameters)}`,
        "image_path specifies the starting image; reference_image_paths are visual references, last_frame_path is the final frame, and keyframes specify images at the given times. Do not merge references into a collage or silently drop requested image arguments. If the tool rejects these arguments, report the failure.",
      ] : []),
      "Treat the following JSON string as the creative prompt for the video:", JSON.stringify(job.prompt),
      "Write the generated video directly to the requested file_path. When generation finishes, send the generated MP4 as an attachment and send a text message containing only a JSON object with video_file_path set to the actual absolute MP4 path under /tmp/. Do this within this same request. If the tool is unavailable or generation fails, report that failure without claiming a video was created.",
    ].filter(Boolean).join("\n") : job.prompt;
    job.phase = "sending";
    await this.save(job);
    const receipt = await this.call("sendPrompt", { agentId: agent.id, prompt, clientNonce: job.clientNonce,
      ...(attachments.length ? { attachmentPaths: attachments } : {}) });
    job.delivery = receipt?.accepted === true ? "accepted" : "unknown";
    job.phase = "submitted";
    job.status = "in_progress";
    await this.save(job);
  }

  async get(id: string): Promise<DesktopJob> {
    if (this.polls.has(id)) return this.polls.get(id)!;
    const work = this.poll(id).finally(() => this.polls.delete(id));
    this.polls.set(id, work);
    return work;
  }
  private async poll(id: string) {
    // A worker can finish while the disk read is pending; that snapshot may still be mid-submission.
    const wasSubmitting = this.active.has(id);
    const job = await this.load(id);
    if (job.status === "completed" || job.status === "failed" || wasSubmitting || this.active.has(id)) return job;
    if (job.phase !== "submitted") {
      this.fail(job, "submission_uncertain", "Service restarted during submission. The task will not be resent; inspect agent_id before retrying.");
      await this.save(job);
      return job;
    }
    const timeout = job.kind === "chat" ? this.config.chatTimeoutMs ?? 120000 : this.config.jobTimeoutMs ?? 1800000;
    if (Date.now() - job.created_at * 1000 > timeout) {
      this.fail(job, "job_timeout", "No completed result before the deadline. This does not cancel the task running in Grok Bot.");
      await this.save(job);
      return job;
    }
    const entries: any[] = [];
    let beforeSeq: number | undefined;
    for (let p = 0; p < 10; p++) {
      const value = page.parse(await this.call("getAgentTranscriptTail", { id: job.agent_id, limit: 200,
        ...(beforeSeq === undefined ? {} : { beforeSeq }) }));
      entries.unshift(...value.entries);
      if (value.nextBeforeSeq === undefined) break;
      if (beforeSeq !== undefined && value.nextBeforeSeq >= beforeSeq) throw new ApiError(502, "Invalid transcript pagination", "upstream_error");
      beforeSeq = value.nextBeforeSeq;
      if (p === 9) throw new ApiError(502, "Transcript is too large to verify task output", "upstream_error");
    }
    // Live gateways may settle by server requestId rather than the supplied clientNonce.
    // Bind that ID only through our own echoed user message, never an arbitrary roster entry.
    const nonces = [job.clientNonce, job.recovery_nonce].filter(Boolean);
    const requestIds = entries.filter(entry => entry.kind === "message" && entry.role === "user" &&
      nonces.includes(entry.clientNonce) && typeof entry.requestId === "string").map(entry => entry.requestId as string);
    const roster = await this.call("listAgents", {});
    const agent = z.array(record).parse(roster).find(a => a.id === job.agent_id);
    const settlement = agent?.lastTurnSettlement as { clientNonce?: string; outcome?: string } | undefined;
    const activeNonce = job.recovery_nonce ?? job.clientNonce;
    const activeRequestIds = entries.filter(entry => entry.kind === "message" && entry.role === "user" &&
      entry.clientNonce === activeNonce && typeof entry.requestId === "string").map(entry => entry.requestId as string);
    const matchedSettlement = typeof settlement?.clientNonce === "string" &&
      (settlement.clientNonce === activeNonce || activeRequestIds.includes(settlement.clientNonce));
    const output: string[] = [];
    let candidate: string | undefined;
    let structuredPath: string | undefined;
    let candidateBound = false;
    for (const entry of entries) {
      if (requestIds.length && entry.requestId && !requestIds.includes(entry.requestId)) continue;
      // Only assistant outputs in this job's isolated Bot are eligible. Never input attachments or tool summaries.
      const isAssistant = entry.kind === "message" && entry.role === "assistant" && entry.isStreaming === false;
      const sent = entry.kind === "send-message" && entry.streaming !== true;
      if (!isAssistant && !sent) continue;
      if (isAssistant && typeof entry.content === "string") output.push(entry.content);
      if (sent && entry.message?.type === "text" && typeof entry.message.content === "string") output.push(entry.message.content);
      const bound = typeof entry.requestId === "string" && requestIds.includes(entry.requestId);
      const text = isAssistant ? entry.content : entry.message?.type === "text" ? entry.message.content : undefined;
      if (bound && typeof text === "string") {
        try {
          const result = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
          if (typeof result.video_file_path === "string" && result.video_file_path.startsWith("/tmp/") && videoPath(result.video_file_path)) {
            structuredPath = result.video_file_path;
          }
        } catch {}
      }
      if (sent && entry.message?.type === "attachment" && typeof entry.message.url === "string" &&
        (videoPath(entry.message.url) || videoPath(entry.message.file_name))) { candidate = entry.message.url; candidateBound = bound; }
      for (const attachment of entry.attachments ?? []) if (videoPath(attachment.url)) { candidate = attachment.url; candidateBound = bound; }
    }
    if (structuredPath) { candidate = structuredPath; candidateBound = true; }
    const generated = entries.some(entry => entry.kind === "tool-call" && /^generate_?video$/i.test(entry.name) && entry.status === "done");
    if (job.kind === "video" && candidate && (generated || candidateBound || (matchedSettlement && settlement?.outcome === "success"))) {
      // Probe through the authenticated gateway; a textual claim/path alone never completes a job.
      try {
        const meta = await this.chunk(job, candidate, 0, 0);
        const header = await this.chunk(job, candidate, 0, Math.min(32, meta.totalSize));
        if (header.bytes.length < 12 || header.bytes.toString("ascii", 4, 8) !== "ftyp") throw new ApiError(502, "Attachment has no MP4 header", "invalid_video");
        job.output_path = candidate; job.generation_tool_verified = generated; job.status = "completed";
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "attachment_unavailable") throw error;
        throw new ApiError(502, "The attachment is unavailable through direct reads. No follow-up prompt was sent", "attachment_unavailable");
      }
    }
    if (matchedSettlement) {
      if (job.kind === "chat" && settlement!.outcome === "success" && output.length) {
        job.text = output.join("\n\n"); job.status = "completed";
      } else if (job.status !== "completed") {
        // Roster settlement can arrive before the transcript/attachment snapshot catches up.
        job.settled_without_output_at ??= Date.now();
        if (settlement!.outcome !== "success" || Date.now() - job.settled_without_output_at >= Math.max(100, (this.config.pollIntervalMs ?? 2000) * 2)) {
          this.fail(job, settlement!.outcome === "success" ? "no_output" : "bot_task_failed",
            job.kind === "video" ? "The Bot finished without a downloadable MP4. Read the Bot transcript for tool availability or approval details."
              : "The Bot finished without a final text response. Read its transcript for details.");
        }
      }
    }
    if (job.status === "completed") job.completed_at = Math.floor(Date.now() / 1000);
    await this.save(job);
    return job;
  }

  async sourcePath(job: DesktopJob) {
    if (job.output_path && /\/assets\/[a-f0-9]{64}\.mp4$/.test(job.output_path)) return job.output_path;
    // Legacy completed jobs may have a /tmp copy; recover only the original attachment metadata, without prompting.
    const value = page.parse(await this.call("getAgentTranscriptTail", { id: job.agent_id, limit: 200 }));
    const requestId = value.entries.find(e => e.kind === "message" && e.role === "user" && e.clientNonce === job.clientNonce)?.requestId;
    if (typeof requestId !== "string") return;
    for (const entry of value.entries as any[]) {
      if (entry.requestId !== requestId) continue;
      if (entry.kind === "send-message" && entry.message?.type === "attachment" && videoPath(entry.message.url)) return entry.message.url as string;
      if (entry.kind === "message" && entry.role === "assistant") {
        for (const item of entry.attachments as any[] ?? []) if (videoPath(item.url)) return item.url as string;
      }
    }
  }

  private async chunk(job: DesktopJob, file: string, offset: number, length: number) {
    const reply = await this.call("readAttachmentChunk", {
      agentId: job.agent_id, path: file.startsWith("file:") ? fileURLToPath(file) : file, offset, length,
    });
    if (reply === null) throw new ApiError(502, "Video attachment is unavailable at this path", "attachment_unavailable");
    const value = z.object({ bytesBase64: z.string(), totalSize: z.number().int().positive().max(1024 * 1024 * 1024),
      mime: z.string().nullable() }).parse(reply);
    if (value.mime !== "video/mp4" && value.mime !== "application/octet-stream") throw new ApiError(502, "The Bot attachment is not an MP4", "invalid_video");
    const bytes = Buffer.from(value.bytesBase64, "base64");
    if (bytes.length > length || (length > 0 && bytes.length === 0)) throw new ApiError(502, "Invalid video chunk", "upstream_error");
    return { ...value, bytes };
  }

  async download(job: DesktopJob, res: ServerResponse, range?: string) {
    if (job.status !== "completed" || !job.output_path) throw new ApiError(409, "Video is not completed", "video_not_ready");
    const meta = await this.chunk(job, job.output_path, 0, 0);
    let start = 0, end = meta.totalSize - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || !(match[1] || match[2])) throw new ApiError(416, "Invalid byte range", "invalid_range");
      if (match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
      else start = Math.max(0, meta.totalSize - Number(match[2]));
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= meta.totalSize) throw new ApiError(416, "Invalid byte range", "invalid_range");
    }
    res.writeHead(range ? 206 : 200, { "Content-Type": "video/mp4", "Content-Length": end - start + 1,
      "Cache-Control": "no-store", "Accept-Ranges": "bytes", "Content-Disposition": `attachment; filename="${job.id}.mp4"`,
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${meta.totalSize}` } : {}) });
    for (let offset = start; offset <= end && !res.destroyed;) {
      const data = await this.chunk(job, job.output_path, offset, Math.min(1024 * 1024, end - offset + 1));
      if (data.totalSize !== meta.totalSize) throw new ApiError(502, "Video size changed during download", "upstream_error");
      offset += data.bytes.length;
      if (!res.write(data.bytes)) {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { res.off("drain", done); res.off("close", done); res.off("error", failed); };
          const done = () => { cleanup(); resolve(); };
          const failed = (error: Error) => { cleanup(); reject(error); };
          res.once("drain", done); res.once("close", done); res.once("error", failed);
        });
      }
    }
    res.end();
  }

  view(job: DesktopJob) {
    const common = { agent_id: job.agent_id, delivery: job.delivery, backend: "grok_bot_task", error: job.error ?? null,
      generation_tool_verified: job.generation_tool_verified ?? false };
    if (job.format === "xai") return { request_id: job.id,
      status: job.status === "completed" ? "done" : job.status === "failed" ? "failed" : "pending", ...common,
      ...(job.status === "completed" ? { video: { url: `/v1/videos/${job.id}/content` } } : {}) };
    return { id: job.id, object: "video", model: job.model, prompt: job.prompt, created_at: job.created_at,
      seconds: job.seconds, size: job.size, status: job.status, progress: job.status === "completed" ? 100 : 0,
      ...(job.completed_at ? { completed_at: job.completed_at } : {}), ...common,
      requested_parameters: { duration: job.duration, aspect_ratio: job.aspect_ratio, resolution: job.resolution },
      ...(job.status === "completed" ? { video: { url: `/v1/videos/${job.id}/content` } } : {}) };
  }
}
