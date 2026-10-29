import { afterEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createServer } from "../src/server.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { videoConfigSchema } from "../src/config/schema.js";
import type { VideoConfig } from "../src/types.js";

const servers: http.Server[] = [];
const directories: string[] = [];
const logger = { info() {}, warn() {}, error() {} };
async function listen(server: http.Server) {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function setup(overrides: VideoConfig = {}) {
  let result: Record<string, unknown> = { status: "pending", progress: 20 };
  let upstreamStatus = 200;
  const calls: { url: string; auth?: string; body?: Record<string, unknown> }[] = [];
  const upstream = await listen(http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    calls.push({ url: req.url!, auth: req.headers.authorization, body: bytes.length ? JSON.parse(bytes.toString()) : undefined });
    res.writeHead(upstreamStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify(upstreamStatus !== 200 ? { secret: "upstream-secret" } : req.method === "POST" ? { request_id: "native-request-123" } : result));
  }));
  const jobsDir = await mkdtemp(path.join(tmpdir(), "grok-video-test-"));
  directories.push(jobsDir);
  const video = { enabled: true, apiKey: "upstream-secret", apiToken: "client-secret", baseUrl: `${upstream}/v1`, jobsDir, ...overrides };
  const start = () => listen(createServer({ ...DEFAULT_CONFIG, video }, logger));
  const url = await start();
  const request = (route: string, payload?: unknown, token = "client-secret") => fetch(`${url}${route}`, {
    method: payload === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { url, start, request, calls, setResult: (value: typeof result) => { result = value; }, setStatus: (value: number) => { upstreamStatus = value; } };
}

describe("video REST API", () => {
  it("requires resolved credentials when enabled", () => {
    expect(videoConfigSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(videoConfigSchema.safeParse({ enabled: true, apiKey: "${XAI_API_KEY}", apiToken: "token" }).success).toBe(false);
  });

  it("is disabled by default and authenticates before calling upstream", async () => {
    const disabled = await setup({ enabled: false });
    expect((await disabled.request("/v1/videos")).status).toBe(503);
    const app = await setup();
    expect((await app.request("/v1/videos", { prompt: "cat" }, "wrong")).status).toBe(401);
    expect(app.calls).toHaveLength(0);
  });

  it("forwards native generation, edit, extension and polling with server credentials", async () => {
    const app = await setup();
    for (const action of ["generations", "edits", "extensions"]) {
      const payload = { prompt: "cat", duration: 6, video: { url: "https://example.com/input.mp4" }, reference_images: [{ url: "https://example.com/image.png" }] };
      expect(await (await app.request(`/v1/videos/${action}`, payload)).json()).toEqual({ request_id: "native-request-123" });
      expect(app.calls.at(-1)?.url).toBe(`/v1/videos/${action}`);
      expect(app.calls.at(-1)?.body).toEqual({ ...payload, model: "grok-imagine-video" });
      expect(app.calls.at(-1)?.auth).toBe("Bearer upstream-secret");
    }
    expect(await (await app.request("/v1/videos/native-request-123")).json()).toEqual({ status: "pending", progress: 20 });
  });

  it("adapts OpenAI fields, survives restart, and maps pending/done/expired", async () => {
    const app = await setup();
    const created = await (await app.request("/v1/videos", { prompt: "cat", seconds: "8", size: "1280x720", input_reference: { image_url: "https://example.com/cat.png" } })).json() as { id: string };
    expect(created).toMatchObject({ object: "video", status: "queued", seconds: "8", size: "1280x720" });
    expect(app.calls[0].body).toMatchObject({ duration: 8, aspect_ratio: "16:9", resolution: "720p", image: { url: "https://example.com/cat.png" } });
    const restartUrl = await app.start();
    const poll = () => fetch(`${restartUrl}/v1/videos/${created.id}`, { headers: { Authorization: "Bearer client-secret" } });
    expect(await (await poll()).json()).toMatchObject({ id: created.id, status: "in_progress", progress: 20 });
    app.setResult({ status: "done", video: { url: "https://vidgen.x.ai/test.mp4", duration: 8 } });
    expect(await (await poll()).json()).toMatchObject({ status: "completed", progress: 100, video: { url: "https://vidgen.x.ai/test.mp4" } });
    app.setResult({ status: "expired" });
    expect(await (await poll()).json()).toMatchObject({ status: "failed", error: { code: "expired" } });
  });

  it("supports multipart image-to-video used by SDKs", async () => {
    const app = await setup();
    const form = new FormData();
    form.set("prompt", "animate this cat");
    form.set("seconds", "4");
    form.set("input_reference", new Blob(["image bytes"], { type: "image/png" }), "cat.png");
    const response = await fetch(`${app.url}/v1/videos`, { method: "POST", headers: { Authorization: "Bearer client-secret" }, body: form });
    expect(response.status).toBe(200);
    expect(app.calls[0].body).toMatchObject({ image: { url: `data:image/png;base64,${Buffer.from("image bytes").toString("base64")}` } });
  });

  it("rejects unsupported parameters, Sora models, invalid durations and oversized bodies before submission", async () => {
    const app = await setup({ maxBodyBytes: 256 });
    for (const payload of [{ prompt: "" }, { prompt: "cat", model: "sora-2" }, { prompt: "cat", size: "1792x1024" }, { prompt: "cat", seconds: "6" }, { prompt: "cat", surprise: true }]) {
      expect((await app.request("/v1/videos", payload)).status).toBe(400);
    }
    expect((await app.request("/v1/videos/generations", { prompt: "cat", duration: 16 })).status).toBe(400);
    expect((await app.request("/v1/videos/edits", { prompt: "cat" })).status).toBe(400);
    expect((await app.request("/v1/videos", { prompt: "x".repeat(300) })).status).toBe(413);
    expect(app.calls).toHaveLength(0);
  });

  it("preserves rate limits without retrying or exposing upstream bodies", async () => {
    const app = await setup();
    app.setStatus(429);
    const response = await app.request("/v1/videos", { prompt: "cat" });
    expect(response.status).toBe(429);
    expect(await response.text()).not.toContain("upstream-secret");
    expect(app.calls).toHaveLength(1);
  });

  it("downloads MP4 without forwarding API tokens to the media host", async () => {
    const app = await setup();
    expect((await app.request("/v1/videos/native-request-123/content")).status).toBe(409);
    app.setResult({ status: "done", video: { url: "https://vidgen.x.ai/test.mp4" } });
    const realFetch = globalThis.fetch;
    const mediaCalls: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input) === "https://vidgen.x.ai/test.mp4") {
        mediaCalls.push(init!);
        return Promise.resolve(new Response(Buffer.from("test-mp4")));
      }
      return realFetch(input, init);
    });
    const download = await app.request("/v1/videos/native-request-123/content");
    expect(download.headers.get("content-type")).toBe("video/mp4");
    expect(await download.text()).toBe("test-mp4");
    expect(mediaCalls[0].headers).toBeUndefined();
    expect((await app.request("/v1/videos/native-request-123/content?variant=thumbnail")).status).toBe(400);
    app.setResult({ status: "done", video: { url: "http://127.0.0.1/private" } });
    expect((await app.request("/v1/videos/native-request-123/content")).status).toBe(502);
  });
});
