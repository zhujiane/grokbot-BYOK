import { afterEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createServer } from "../src/server.js";
import { DEFAULT_CONFIG } from "../src/config.js";

const servers: http.Server[] = [], dirs: string[] = [];
const listen = async (server: http.Server) => {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
};
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => { s.close(() => resolve()); s.closeAllConnections(); })));
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});
async function setup() {
  vi.stubEnv("UI_USERNAME", "admin"); vi.stubEnv("UI_PASSWORD", "test-ui-password");
  const dir = await mkdtemp(path.join(tmpdir(), "video-ui-")); dirs.push(dir);
  const jobsDir = path.join(dir, "desktop-jobs");
  const config = { ...DEFAULT_CONFIG, providers: { priority: [], configs: {} }, api: { enabled: true, apiToken: "private-api-token" },
    grokBot: { enabled: true, videoEnabled: true, jobsDir, credentialsFile: path.join(dir, "missing.json") } };
  const url = await listen(createServer(config, { info() {}, warn() {}, error() {} }));
  const request = (route: string, body?: unknown, cookie?: string, origin = url) => fetch(url + route, {
    method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const login = async () => {
    const response = await request("/ui/login", { username: "admin", password: "test-ui-password" });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    return response.headers.get("set-cookie")!.split(";")[0];
  };
  return { dir, jobsDir, url, request, login };
}
describe("video workbench authentication and credentials", () => {
  it("serves the page without exposing secrets; protects API and downloads with a signed login cookie", async () => {
    const app = await setup();
    const page = await (await app.request("/")).text();
    expect(page).toContain("Grok Video 工作台"); expect(page).not.toContain("private-api-token"); expect(page).not.toContain("test-ui-password");
    expect((await app.request("/v1/models")).status).toBe(401);
    expect((await app.request("/ui/session")).status).toBe(401);
    expect((await app.request("/ui/login", { username: "admin", password: "wrong" })).status).toBe(401);
    const cookie = await app.login();
    expect((await app.request("/v1/models", undefined, cookie)).status).toBe(200);
    expect((await app.request("/v1/models", undefined, cookie + "tampered")).status).toBe(401);
    expect((await app.request("/v1/bots", undefined, cookie)).status).toBe(401);
    expect((await app.request("/ui/export-session.cjs", undefined, cookie)).status).toBe(200);
    expect((await app.request("/ui/logout", {}, cookie)).status).toBe(200);
    expect((await app.request("/v1/models", undefined, "grok_ui=")).status).toBe(401);
  });
  it("blocks cross-origin mutations and limits failed login attempts", async () => {
    const app = await setup(), cookie = await app.login();
    expect((await app.request("/ui/login", {}, undefined, "https://other.example")).status).toBe(403);
    expect((await app.request("/ui/credentials", {}, cookie, "https://other.example")).status).toBe(403);
    expect((await app.request("/v1/videos", { prompt: "cat" }, cookie, "https://other.example")).status).toBe(403);
    for (let i = 0; i < 10; i++) expect((await app.request("/ui/login", { username: "admin", password: "bad" })).status).toBe(401);
    expect((await app.request("/ui/login", { username: "admin", password: "test-ui-password" })).status).toBe(429);
  });
  it("imports credentials atomically into the data volume without returning secrets and keeps API bearer authentication", async () => {
    const app = await setup(), cookie = await app.login();
    const descriptor = { version: 1, gatewayUrl: "https://test.cursorvm.com", gatewayToken: "private-gateway-token", headers: { "x-anyrun-network-token": "private-network-token" } };
    expect((await app.request("/ui/credentials", descriptor)).status).toBe(401);
    const response = await app.request("/ui/credentials", descriptor, cookie);
    expect(response.status).toBe(200); expect(await response.text()).not.toContain("private-");
    const filename = path.join(app.dir, "ui-session.json");
    expect(JSON.parse(await readFile(filename, "utf8"))).toEqual(descriptor);
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    expect((await (await app.request("/v1/auth/status", undefined, cookie)).json() as any).grok_bot.session_imported).toBe(true);
    expect((await app.request("/ui/credentials", { ...descriptor, gatewayUrl: "http://example.com" }, cookie)).status).toBe(400);
    expect(JSON.parse(await readFile(filename, "utf8"))).toEqual(descriptor);
    const bearer = await fetch(app.url + "/v1/models", { headers: { Authorization: "Bearer private-api-token" } });
    expect(bearer.status).toBe(200);
    const second = await listen(createServer({ ...DEFAULT_CONFIG, providers: { priority: [], configs: {} }, api: { enabled: true, apiToken: "private-api-token" }, grokBot: { enabled: true, videoEnabled: true, jobsDir: app.jobsDir } }, { info() {}, warn() {}, error() {} }));
    expect((await (await fetch(second + "/v1/auth/status", { headers: { Cookie: cookie } })).json() as any).grok_bot.session_imported).toBe(true);
  });
  it("streams completed video with cookie auth and byte ranges for browser preview", async () => {
    const app = await setup(), cookie = await app.login();
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from("ftypisom-test-video-bytes")]);
    const gateway = await listen(http.createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
      const b = JSON.parse(Buffer.concat(chunks).toString());
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ mime: "video/mp4", totalSize: mp4.length, bytesBase64: mp4.subarray(b.offset, b.offset + b.length).toString("base64") }));
    }));
    await app.request("/ui/credentials", { version: 1, gatewayUrl: gateway, gatewayToken: "test" }, cookie);
    const id = "video_12345678-1234-4234-8234-123456789abc";
    await mkdir(app.jobsDir, { recursive: true });
    await writeFile(path.join(app.jobsDir, id + ".json"), JSON.stringify({ version: 1, id, kind: "video", status: "completed", agent_id: "bot", output_path: "/tmp/video.mp4" }));
    const response = await fetch(app.url + "/v1/videos/" + id + "/content", { headers: { Cookie: cookie, Range: "bytes=0-7" } });
    expect(response.status).toBe(206); expect(response.headers.get("content-range")).toBe("bytes 0-7/" + mp4.length);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(mp4.subarray(0, 8));
  });
});
