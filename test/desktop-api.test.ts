import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "../src/server.js";
import { DEFAULT_CONFIG } from "../src/config.js";

const servers: http.Server[] = [];
const dirs: string[] = [];
const logger = { info() {}, warn() {}, error() {} };
async function listen(server: http.Server) {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve()); server.closeAllConnections();
  })));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const calls: { method: string; body: any; auth?: string }[] = [];
  const bots = new Map<string, { nonce?: string; prompt?: string; entries: any[] }>();
  let asleep = false, settle = false, failSend = false;
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from("ftypisom-test-video-bytes")]);
  const upstream = await listen(http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const method = req.url!.slice("/api/".length);
    calls.push({ method, body, auth: req.headers.authorization });
    if (asleep) { res.writeHead(417); res.end(); return; }
    if (failSend && method === "sendPrompt") { res.writeHead(500); res.end("private-upstream-secret"); return; }
    let reply: unknown = null;
    if (method === "listAgents") reply = [...bots].map(([id, bot]) => ({ id, isRunning: false,
      ...(settle && bot.nonce ? { lastTurnSettlement: { clientNonce: bot.nonce, outcome: "success", settledAtMs: Date.now() } } : {}) }));
    if (method === "createAgent") {
      const id = `bot-${bots.size + 1}`;
      bots.set(id, { entries: [] }); reply = { agent: { id }, transcript: [] };
    }
    if (method === "sendPrompt") {
      Object.assign(bots.get(body.agentId)!, { nonce: body.clientNonce, prompt: body.prompt }); reply = { accepted: true };
    }
    if (method === "getAgentTranscriptTail") reply = { entries: bots.get(body.id)?.entries ?? [] };
    if (method === "uploadAttachment") reply = { path: `/uploads/${body.filename}` };
    if (method === "readAttachmentChunk" && body.path !== "/missing.mp4") reply = { mime: "video/mp4", totalSize: mp4.length,
      bytesBase64: mp4.subarray(body.offset, body.offset + body.length).toString("base64") };
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(reply));
  }));
  const dir = await mkdtemp(path.join(tmpdir(), "desktop-api-")); dirs.push(dir);
  const credentialsFile = path.join(dir, "session.json"), jobsDir = path.join(dir, "jobs");
  await writeFile(credentialsFile, JSON.stringify({ version: 1, gatewayUrl: upstream, gatewayToken: "desktop-secret" }));
  const config = { ...DEFAULT_CONFIG, providers: { priority: [], configs: {} }, api: { enabled: true, apiToken: "client-secret" },
    grokBot: { enabled: true, videoEnabled: true, chatEnabled: true, credentialsFile, jobsDir, pollIntervalMs: 10, chatTimeoutMs: 10000 } };
  const start = () => listen(createServer(config, logger));
  const url = await start();
  const request = (route: string, payload?: unknown, headers: Record<string, string> = {}) => fetch(`${url}${route}`, {
    method: payload === undefined ? "GET" : "POST", headers: { Authorization: "Bearer client-secret", "Content-Type": "application/json", ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload) });
  const submitted = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const job = await (await request(`/v1/videos/${id}`)).json() as any;
      if (job.delivery || job.status === "failed") return job;
      await delay(10);
    }
    throw new Error("Not submitted");
  };
  return { request, url, start, calls, bots, dir, jobsDir, mp4, submitted,
    asleep: () => { asleep = true; }, settle: () => { settle = true; }, failSend: () => { failSend = true; } };
}

describe("desktop Bot video and chat adapter", () => {
  it.each([false, true])("maps multiple images, final frames and timed keyframes in one submission (xAI=%s)", async native => {
    const app = await setup();
    const image = (text: string) => `data:image/png;base64,${Buffer.from(text).toString("base64")}`;
    const payload = {
      prompt: "consistent character motion",
      ...(native ? { image: { url: image("first") }, duration: 4 } : { input_reference: { image_url: image("first") }, seconds: "4" }),
      reference_images: [{ url: image("ref-a") }, { url: "https://example.com/ref-b.jpg" }],
      last_frame: { url: image("last") },
      keyframes: [{ url: image("frame-3"), timestamp_seconds: 3 }, { url: image("frame-1"), timestamp_seconds: 1 }],
    };
    const response = await app.request(native ? "/v1/videos/generations" : "/v1/videos", payload);
    expect(response.status).toBe(200);
    const created = await response.json() as any;
    const id = created.id ?? created.request_id;
    const submitted = await app.submitted(id);
    const sent = app.calls.filter(c => c.method === "sendPrompt");
    expect(sent).toHaveLength(1);
    expect(sent[0].body.agentId).toBe(submitted.agent_id);
    const args = JSON.parse(sent[0].body.prompt.split("Use these exact image arguments for GenerateVideo: ")[1].split("\n")[0]);
    expect(args).toEqual({
      image_path: "/uploads/reference.png",
      reference_image_paths: ["/uploads/reference-1.png", `/tmp/grokbot-${id}-image-2`],
      last_frame_path: "/uploads/reference-3.png",
      keyframes: [
        { image_path: "/uploads/reference-4.png", timestamp_seconds: 1 },
        { image_path: "/uploads/reference-5.png", timestamp_seconds: 3 },
      ],
    });
    expect(sent[0].body.prompt).toContain('Download the image from "https://example.com/ref-b.jpg"');
    expect(sent[0].body.attachmentPaths).toHaveLength(5);
    expect(app.calls.filter(c => c.method === "uploadAttachment").map(c => c.body.bytesBase64))
      .toEqual(["first", "ref-a", "last", "frame-1", "frame-3"].map(t => Buffer.from(t).toString("base64")));
    const saved = await readFile(path.join(app.jobsDir, `${id}.json`), "utf8");
    expect(saved).not.toContain("data:image");
    expect(saved).not.toContain("example.com");
  });

  it("rejects invalid image collections and keyframe times before any Bot calls", async () => {
    const app = await setup();
    const good = { url: "https://example.com/ref.png" };
    const cases = [
      { reference_images: [] }, { reference_images: Array(9).fill(good) },
      { reference_images: [{ url: "file:///etc/passwd" }] },
      { last_frame: { url: "data:image/gif;base64,YQ==" } },
      { keyframes: [{ ...good, timestamp_seconds: -1 }] },
      { keyframes: [{ ...good, timestamp_seconds: 5 }] },
      { keyframes: [{ ...good, timestamp_seconds: 1 }, { ...good, timestamp_seconds: 1 }] },
      { keyframes: Array.from({ length: 17 }, (_, i) => ({ ...good, timestamp_seconds: i / 10 })) },
    ];
    for (const native of [false, true]) {
      for (const options of cases) {
        expect((await app.request(native ? "/v1/videos/generations" : "/v1/videos", { prompt: "cat", ...options })).status).toBe(400);
      }
    }
    expect(app.calls).toEqual([]);
  });

  it("publishes adapter models, authenticates and reports sleep without creating tasks", async () => {
    const app = await setup();
    const models = await (await app.request("/v1/models")).json() as any;
    expect(models.data.map((m: any) => m.id)).toEqual(["grok-bot", "grok-bot-video"]);
    expect(models.grok_bot_model_catalog_available).toBe(false);
    expect((await app.request("/v1/videos", { prompt: "cat" }, { Authorization: "wrong" })).status).toBe(401);
    app.asleep();
    const response = await app.request("/v1/videos", { prompt: "cat" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "desktop_asleep" } });
    expect(app.calls.map(c => c.method)).toEqual(["listAgents"]);
  });

  it("runs an isolated video task and requires real assistant media before completion; persists across restart and streams ranges", async () => {
    const app = await setup();
    const created = await (await app.request("/v1/videos", { prompt: "cat in flowers", seconds: "8", size: "720x1280" })).json() as any;
    expect(created).toMatchObject({ object: "video", status: "queued", model: "grok-bot-video" });
    const pending = await app.submitted(created.id);
    const bot = app.bots.get(pending.agent_id)!;
    expect(bot.prompt).toContain('duration_seconds=8, aspect_ratio="9:16"');
    expect(bot.prompt).toContain(`file_path="/tmp/grokbot-${created.id}.mp4"`);
    expect(app.calls.filter(c => c.method === "sendPrompt")).toHaveLength(1);
    // A user attachment or a tool's summary is never accepted as the generated result.
    bot.entries = [{ id: "input", kind: "user-attachment", file_path: "/fake.mp4" },
      { id: "tool", kind: "tool-call", name: "GenerateVideo", status: "done", summary: "/fake.mp4" }];
    expect((await (await app.request(`/v1/videos/${created.id}`)).json() as any).status).toBe("in_progress");
    bot.entries.push({ id: "result", kind: "send-message", message: { type: "attachment", url: "/outputs/cat.mp4" } });
    const complete = await (await app.request(`/v1/videos/${created.id}`)).json() as any;
    expect(complete.status).toBe("completed");
    const restarted = await app.start();
    const loaded = await fetch(`${restarted}/v1/videos/${created.id}`, { headers: { Authorization: "Bearer client-secret" } });
    expect((await loaded.json() as any).status).toBe("completed");
    const download = await app.request(`/v1/videos/${created.id}/content`);
    expect(download.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(app.mp4);
    const link = await (await app.request(`/v1/videos/${created.id}/download-url`)).json() as any;
    const publicDownload = await fetch(app.url + link.url);
    expect(publicDownload.status).toBe(200);
    expect(Buffer.from(await publicDownload.arrayBuffer())).toEqual(app.mp4);
    expect((await fetch(app.url + link.url.replace(/signature=[0-9a-f]+/, "signature=" + "0".repeat(64)))).status).toBe(401);
    expect((await fetch(app.url + link.url.replace(/expires=\d+/, "expires=1000000000"))).status).toBe(401);
    expect((await fetch(app.url + `/v1/models?${link.url.split("?")[1]}`)).status).toBe(401);

    const partial = await app.request(`/v1/videos/${created.id}/content`, undefined, { Range: "bytes=2-7" });
    expect(partial.status).toBe(206); expect(Buffer.from(await partial.arrayBuffer())).toEqual(app.mp4.subarray(2, 8));
    expect((await app.request(`/v1/videos/${created.id}/content`, undefined, { Range: "bytes=999-" })).status).toBe(416);
    expect(app.calls.every(c => c.auth === "Bearer desktop-secret")).toBe(true);
  });

  it("supports xAI request_id/pending/done shapes and multipart reference uploads without claiming unsupported operations", async () => {
    const app = await setup();
    expect((await app.request("/v1/videos/edits", {})).status).toBe(501);
    expect((await app.request("/v1/videos", { prompt: "cat", model: "sora-2" })).status).toBe(400);
    expect((await app.request("/v1/videos", { prompt: "cat", input_reference: { image_url: "file:///etc/passwd" } })).status).toBe(400);
    const native = await (await app.request("/v1/videos/generations", { prompt: "cat", duration: 5, aspect_ratio: "1:1" })).json() as any;
    expect(native.request_id).toMatch(/^video_/);
    const submitted = await app.submitted(native.request_id);
    expect(submitted.status).toBe("pending");
    app.bots.get(submitted.agent_id)!.entries = [{ kind: "tool-call", id: "tool", name: "GenerateVideo", status: "done" }, { kind: "send-message", id: "v", message: { type: "attachment", url: "/video.mp4" } }];
    expect(await (await app.request(`/v1/videos/${native.request_id}`)).json()).toMatchObject({ request_id: native.request_id, status: "done" });
    const form = new FormData(); form.set("prompt", "animate cat"); form.set("input_reference", new Blob([Buffer.from("png")], { type: "image/png" }), "ref.png");
    const response = await fetch(`${app.url}/v1/videos`, { method: "POST", headers: { Authorization: "Bearer client-secret" }, body: form });
    const created = await response.json() as any; await app.submitted(created.id);
    expect(app.calls.find(c => c.method === "uploadAttachment")?.body).toMatchObject({ filename: "reference.png", bytesBase64: "cG5n" });
    const saved = await readFile(path.join(app.jobsDir, `${created.id}.json`), "utf8");
    expect(saved).not.toContain("cG5n");
  });

  it("matches live server request IDs and downloads file URL attachments without claiming tool verification", async () => {
    const app = await setup();
    const created = await (await app.request("/v1/videos", { prompt: "cat" })).json() as any;
    const pending = await app.submitted(created.id);
    const bot = app.bots.get(pending.agent_id)!;
    const nonce = bot.nonce;
    bot.nonce = "server-request-id";
    bot.entries = [
      { kind: "message", id: "user", role: "user", clientNonce: nonce, requestId: "server-request-id", isStreaming: false },
      { kind: "send-message", id: "output", requestId: "server-request-id", message: { type: "attachment", url: "file:///home/box/assets/cat.mp4" } },
    ];
    // An attachment from another request must never complete this task.
    bot.entries[1].requestId = "unrelated-request-id";
    expect(await (await app.request(`/v1/videos/${created.id}`)).json()).toMatchObject({ status: "in_progress" });
    bot.entries[1].requestId = "server-request-id";
    app.settle();
    expect(await (await app.request(`/v1/videos/${created.id}`)).json()).toMatchObject({ status: "completed", generation_tool_verified: false });
    const response = await app.request(`/v1/videos/${created.id}/content`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(app.mp4);
    expect(app.calls.filter(c => c.method === "readAttachmentChunk").every(c => c.body.path === "/home/box/assets/cat.mp4")).toBe(true);
  });

  it("uses the same request's generated output path even if an unreadable attachment follows it", async () => {
    const app = await setup();
    const created = await (await app.request("/v1/videos", { prompt: "cat" })).json() as any;
    const pending = await app.submitted(created.id);
    const bot = app.bots.get(pending.agent_id)!;
    const file = `/tmp/grokbot-${created.id}.mp4`;
    bot.entries = [
      { kind: "message", id: "user", role: "user", clientNonce: bot.nonce, requestId: "generation", isStreaming: false },
      { kind: "send-message", id: "path", requestId: "generation", message: { type: "text", content: JSON.stringify({ video_file_path: file }) } },
      { kind: "send-message", id: "attachment", requestId: "generation", message: { type: "attachment", url: "/missing.mp4" } },
    ];
    expect(await (await app.request(`/v1/videos/${created.id}`)).json()).toMatchObject({ status: "completed", generation_tool_verified: false });
    const response = await app.request(`/v1/videos/${created.id}/content`);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(app.mp4);
    expect(app.calls.filter(c => c.method === "readAttachmentChunk").every(c => c.body.path === file)).toBe(true);
    expect(app.calls.filter(c => c.method === "sendPrompt")).toHaveLength(1);
  });

  it("reports a missing attachment without sending another Bot prompt", async () => {
    const app = await setup();
    const created = await (await app.request("/v1/videos", { prompt: "cat" })).json() as any;
    const pending = await app.submitted(created.id);
    const bot = app.bots.get(pending.agent_id)!;
    bot.entries = [
      { kind: "message", id: "user", role: "user", clientNonce: bot.nonce, requestId: "original", isStreaming: false },
      { kind: "send-message", id: "media", requestId: "original", message: { type: "attachment", url: "file:///missing.mp4" } },
    ];
    const response = await app.request(`/v1/videos/${created.id}`);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "attachment_unavailable" } });
    await app.request(`/v1/videos/${created.id}`);
    expect(app.calls.filter(c => c.method === "sendPrompt")).toHaveLength(1);
  });

  it("does not replay uncertain submissions and reports completed turns with no video as failures", async () => {
    const app = await setup(); app.failSend();
    const created = await (await app.request("/v1/videos", { prompt: "cat" })).json() as any;
    const failed = await app.submitted(created.id);
    expect(failed).toMatchObject({ status: "failed", error: { code: "submission_uncertain" } });
    expect(JSON.stringify(failed)).not.toContain("private-upstream-secret");
    await app.request(`/v1/videos/${created.id}`);
    expect(app.calls.filter(c => c.method === "sendPrompt")).toHaveLength(1);
    const restarted = await app.start();
    const interrupted = { ...JSON.parse(await readFile(path.join(app.jobsDir, `${created.id}.json`), "utf8")), status: "queued", phase: "sending" };
    await writeFile(path.join(app.jobsDir, `${created.id}.json`), JSON.stringify(interrupted));
    await fetch(`${restarted}/v1/videos/${created.id}`, { headers: { Authorization: "Bearer client-secret" } });
    expect(app.calls.filter(c => c.method === "sendPrompt")).toHaveLength(1);
  });

  it("fails a settled video task without media and waits for the matching final turn in chat JSON/SSE", async () => {
    const app = await setup();
    const created = await (await app.request("/v1/videos", { prompt: "cat" })).json() as any;
    const pending = await app.submitted(created.id);
    app.bots.get(pending.agent_id)!.entries = [{ id: "m", kind: "message", role: "assistant", content: "I cannot generate video", isStreaming: false }];
    app.settle();
    await app.request(`/v1/videos/${created.id}`);
    await delay(120);
    expect(await (await app.request(`/v1/videos/${created.id}`)).json()).toMatchObject({ status: "failed", error: { code: "no_output" } });
    const fillChat = async () => {
      for (let i = 0; i < 200; i++) {
        const chat = [...app.bots.values()].filter(b => b.prompt?.startsWith("Answer the last user message"));
        for (const bot of chat) bot.entries = [{ kind: "send-message", id: "answer", message: { type: "text", content: "Hello" } }];
        if (chat.length) return;
        await delay(10);
      }
    };
    const fill = fillChat();
    const response = await app.request("/v1/chat/completions", { model: "grok-bot", messages: [{ role: "user", content: "hi" }] });
    await fill;
    expect(await response.json()).toMatchObject({ object: "chat.completion", choices: [{ message: { content: "Hello" } }] });
    const stream = await app.request("/v1/chat/completions", { model: "grok-bot", messages: [{ role: "user", content: "hi" }], stream: true });
    // The second task must also get its own output.
    for (let i = 0; i < 200 && app.bots.size < 3; i++) await delay(10);
    for (const bot of app.bots.values()) if (bot.prompt?.startsWith("Answer the last user message")) bot.entries = [{ kind: "send-message", id: "answer", message: { type: "text", content: "Hello" } }];
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    expect(await stream.text()).toContain("data: [DONE]");
    expect((await readdir(app.jobsDir)).filter(f => f.startsWith("chat_")).length).toBe(2);
  });
});
