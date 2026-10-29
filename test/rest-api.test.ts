import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { createCipheriv, randomBytes } from "node:crypto";
import { createServer } from "../src/server.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { parseConfig } from "../src/config/schema.js";

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
  const calls: { url: string; auth?: string; network?: string; body: Record<string, unknown> }[] = [];
  let status = 200;
  const mock = await listen(http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ url: req.url!, auth: req.headers.authorization, network: req.headers["x-anyrun-network-token"] as string, body });
    res.writeHead(status, { "Content-Type": body.stream ? "text/event-stream" : "application/json" });
    if (status !== 200) res.end(JSON.stringify({ error: "sensitive-upstream-body" }));
    else if (body.stream) res.end('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n');
    else res.end(JSON.stringify(req.url === "/api/listAgents" ? { agents: [{ id: "bot-123", name: "My Bot" }] }
      : req.url === "/api/sendPrompt" ? { messageId: "msg-123" } : req.url === "/v1/chat/completions"
        ? { object: "chat.completion", choices: [{ message: { role: "assistant", content: "hello" } }] } : { entries: [] }));
  }));
  const dir = await mkdtemp(path.join(tmpdir(), "grok-rest-test-"));
  dirs.push(dir);
  const credentialsFile = path.join(dir, "session.json");
  await writeFile(credentialsFile, JSON.stringify({ version: 1, gatewayUrl: mock, gatewayToken: "desktop-secret", headers: { "x-anyrun-network-token": "network-secret", Authorization: "ignore-this" } }));
  const config = { ...DEFAULT_CONFIG, api: { enabled: true, apiToken: "client-secret" },
    grokBot: { enabled: true, credentialsFile },
    providers: { priority: ["test", "unset"], configs: {
      test: { baseUrl: `${mock}/v1`, apiKey: "provider-secret", defaultModel: "test-model", models: { alias: "test-model" } },
      unset: { baseUrl: `${mock}/v1`, apiKey: "${MISSING_KEY}", defaultModel: "unavailable-model", models: {} },
    } } };
  const url = await listen(createServer(config, logger));
  const request = (route: string, payload?: unknown, token = "client-secret") => fetch(`${url}${route}`, {
    method: payload === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { url, request, calls, credentialsFile, setStatus: (s: number) => { status = s; } };
}

describe("REST deployment", () => {
  it("validates gateway access token and leaves health check public", async () => {
    expect(() => parseConfig({ ...DEFAULT_CONFIG, api: { enabled: true, apiToken: "${API_TOKEN}" } })).toThrow();
    const app = await setup();
    expect((await app.request("/healthz", undefined, "")).status).toBe(200);
    expect((await app.request("/v1/models", undefined, "wrong")).status).toBe(401);
    expect((await app.request("/aiserver.v1.InferenceService/Stream", {})).status).toBe(403);
  });

  it("lists configured model routes without inventing desktop entitlements or exposing keys", async () => {
    const app = await setup();
    const response = await app.request("/v1/models");
    const text = await response.text();
    const result = JSON.parse(text);
    expect(result.data.map((m: { id: string }) => m.id)).toEqual(["test-model", "alias"]);
    expect(result.grok_bot_model_catalog_available).toBe(false);
    expect(text).not.toContain("secret");
  });

  it("imports desktop credentials for read-only Bot calls, forwards routing headers and re-reads exports", async () => {
    const app = await setup();
    expect(await (await app.request("/v1/bots")).json()).toEqual({ agents: [{ id: "bot-123", name: "My Bot" }] });
    expect(app.calls[0]).toMatchObject({ url: "/api/listAgents", auth: "Bearer desktop-secret", network: "network-secret" });
    expect(await (await app.request("/v1/auth/status")).json()).toMatchObject({ grok_bot: { upstream_verified: true } });
    await writeFile(app.credentialsFile, JSON.stringify({ version: 1, gatewayUrl: app.url, gatewayToken: "replacement" }));
    const state = await app.request("/v1/auth/status");
    expect(await state.text()).not.toContain("replacement");
  });

  it("submits asynchronous Bot tasks, and exposes transcripts and threads", async () => {
    const app = await setup();
    const sent = await app.request("/v1/bots/bot-123/messages", { prompt: "test task" });
    expect(sent.status).toBe(202);
    expect(await sent.json()).toMatchObject({ agentId: "bot-123", delivery: "accepted", result: { messageId: "msg-123" } });
    expect(app.calls[0].body).toMatchObject({ agentId: "bot-123", prompt: "test task" });
    expect(app.calls[0].body.clientNonce).toMatch(/^[0-9a-f-]+$/);
    expect((await app.request("/v1/bots/bot-123/transcript?limit=10")).status).toBe(200);
    expect(app.calls.at(-1)?.body).toEqual({ id: "bot-123", limit: 10 });
    expect((await app.request("/v1/bots/bot-123/thread?root_id=msg-123")).status).toBe(200);
    expect(app.calls.at(-1)?.body).toEqual({ id: "bot-123", rootId: "msg-123" });
    expect((await app.request("/v1/bots/bot-123/acceptance?account_slot=test-account&client_nonce=7f691214-01a3-47d8-8ca3-6ce15b18a261")).status).toBe(200);
    expect(app.calls.at(-1)?.body).toEqual({ agentId: "bot-123", clientNonce: "7f691214-01a3-47d8-8ca3-6ce15b18a261", accountSlot: "test-account" });
    expect((await app.request("/v1/bots/bot-123/thread")).status).toBe(400);
  });

  it("does not retry task submissions or leak upstream error details", async () => {
    const app = await setup();
    app.setStatus(401);
    const response = await app.request("/v1/bots/bot-123/messages", { prompt: "test task" });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("sensitive-upstream-body");
    expect(app.calls).toHaveLength(1);
    await rm(app.credentialsFile);
    expect((await app.request("/v1/bots")).status).toBe(503);
  });

  it("exposes chat completions and SSE only for configured chat models", async () => {
    const app = await setup();
    const body = { model: "alias", messages: [{ role: "user", content: "hello" }] };
    const response = await app.request("/v1/chat/completions", body);
    expect(await response.json()).toMatchObject({ object: "chat.completion" });
    expect(app.calls.at(-1)).toMatchObject({ auth: "Bearer provider-secret", body: { model: "test-model", stream: false } });
    const stream = await app.request("/v1/chat/completions", { ...body, stream: true });
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    expect(await stream.text()).toContain("data: [DONE]");
    expect((await app.request("/v1/chat/completions", { ...body, model: "invented-model" })).status).toBe(404);
  });
});

describe("Windows desktop export codec", () => {
  const require = createRequire(import.meta.url);
  const { decryptWindows, selectPayload } = require("../scripts/export-grok-bot-session.cjs");

  it("reads single-account descriptor versions 1, 2 and 3 without choosing between accounts", () => {
    expect(selectPayload({ version: 1, encrypted: "a" })).toBe("a");
    for (const version of [2, 3]) {
      expect(selectPayload({ version, entries: { account: { encrypted: "a" } } })).toBe("a");
      expect(() => selectPayload({ version, entries: { a: { encrypted: "a" }, b: { encrypted: "b" } } })).toThrow();
      expect(selectPayload({ version, entries: { a: { encrypted: "a" }, b: { encrypted: "b" } } }, "b")).toBe("b");
    }
    expect(() => selectPayload({ version: 3, entries: { a: { unknown: "a" } } })).toThrow();
  });

  it("decrypts authenticated Windows Safe Storage data and rejects incorrect keys", () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const expected = { baseUrl: "https://example.com", token: "test-token" };
    const encrypted = Buffer.concat([Buffer.from("v10"), nonce, cipher.update(JSON.stringify(expected)), cipher.final(), cipher.getAuthTag()]).toString("base64");
    expect(decryptWindows(encrypted, key)).toEqual(expected);
    expect(() => decryptWindows(encrypted, randomBytes(32))).toThrow();
  });
});
