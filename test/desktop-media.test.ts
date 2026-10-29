import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, randomBytes } from "node:crypto";
import { DesktopMedia, attachmentAlias } from "../src/desktop/media.js";
const { backendSession, findAppDir, readGatewaySession } = createRequire(import.meta.url)("../scripts/export-grok-bot-session.cjs");
const id = "bot-1", path = `/home/box/agent-data/agents/${id}/assets/${"a".repeat(64)}.mp4`;
const session = { baseUrl: "https://api2.cursor.sh", accessToken: "account-secret", clientVersion: "0.77.0", machineId: "machine", teamId: 123 };
function resolver(url = "https://storage.example/video?signature=secret", expires = Date.now() + 3600000) {
  return Response.json({ reads: [{ path, outcome: "STORE", url, expiresAtMs: String(expires), sizeBytes: "12", contentType: "video/mp4" }] });
}
describe("direct desktop attachment store", () => {
  it("validates canonical aliases and account boundaries", () => {
    expect(attachmentAlias("file://" + path, id)).toEqual({ path, agentId: id });
    expect(attachmentAlias(path.replace("agent-data", "sand-data"), id)?.path).toBe(path);
    expect(attachmentAlias(path, "other")).toBeUndefined();
    expect(attachmentAlias(path.replace("bot-1", ".."))).toBeUndefined();
    expect(attachmentAlias("file://attacker.example" + path)).toBeUndefined();
    expect(attachmentAlias("/tmp/api-video.mp4")).toBeUndefined();
  });
  it("resolves once, reads byte ranges and never forwards credentials to storage", async () => {
    const fetcher = vi.fn(async (url: any, options: any) => {
      if (String(url).includes("GrokBotService")) {
        expect(options.headers.Authorization).toBe("Bearer account-secret");
        expect(JSON.parse(options.body)).toEqual({ agentId: id, paths: [path] });
        return resolver();
      }
      expect(options.headers).toEqual({ Range: "bytes=0-11" });
      return new Response("0000ftypisom", { status: 206, headers: { "content-range": "bytes 0-11/12" } });
    });
    const media = new DesktopMedia(async () => session, fetcher as any);
    expect(await media.chunk(path, id, 0, 0)).toMatchObject({ totalSize: 12, bytesBase64: "" });
    expect(await media.chunk(path, id, 0, 12)).toMatchObject({ totalSize: 12, bytesBase64: Buffer.from("0000ftypisom").toString("base64") });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("requires imported account credentials and rejects untrusted backend origins", async () => {
    const fetcher = vi.fn();
    await expect(new DesktopMedia(async () => undefined, fetcher).resolve(path, id)).rejects.toMatchObject({ code: "desktop_backend_session_missing" });
    await expect(new DesktopMedia(async () => ({ ...session, baseUrl: "https://attacker.example" }), fetcher).resolve(path, id)).rejects.toMatchObject({ code: "desktop_backend_session_invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("sanitizes errors, rejects expired or non-HTTPS links, and refreshes expired storage signatures", async () => {
    const failed = new DesktopMedia(async () => session, vi.fn(async () => new Response("private-secret", { status: 401 })) as any);
    await expect(failed.resolve(path)).rejects.toMatchObject({ code: "desktop_attachment_resolver_error" });
    for (const reply of [() => resolver("http://storage.example/video"), () => resolver(undefined, Date.now() - 1)]) {
      await expect(new DesktopMedia(async () => session, vi.fn(async () => reply()) as any).resolve(path)).rejects.toMatchObject({ code: "upstream_error" });
    }
    const fetcher = vi.fn().mockResolvedValueOnce(resolver()).mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(resolver()).mockResolvedValueOnce(new Response("0000ftypisom", { status: 206, headers: { "content-range": "bytes 0-11/12" } }));
    await expect(new DesktopMedia(async () => session, fetcher).chunk(path, id, 0, 12)).resolves.toMatchObject({ totalSize: 12 });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("discovers moved desktop folders and reuses a previous export without a gateway descriptor", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-export-"));
    try {
      const preferred = join(root, "Grok Bot"), actual = join(root, "Grok Bot Beta");
      mkdirSync(actual);
      writeFileSync(join(actual, "Local State"), "{}");
      writeFileSync(join(actual, "sand-secrets.json"), "{}");
      expect(() => findAppDir(preferred, [root], true, false)).toThrow("--gateway-session");
      expect(findAppDir(preferred, [root], true, true)).toBe(actual);
      writeFileSync(join(actual, "gateway-descriptor.json"), "{}");
      expect(findAppDir(preferred, [root], true, false)).toBe(actual);
      expect(() => findAppDir(preferred, [root], true, false, true)).toThrow("not found together");
      const other = join(root, "Grok Bot Other");
      mkdirSync(other);
      for (const file of ["Local State", "sand-secrets.json", "gateway-descriptor.json"]) writeFileSync(join(other, file), "{}");
      expect(() => findAppDir(preferred, [root], true, false)).toThrow("Multiple");
      const saved = join(root, "session.json");
      writeFileSync(saved, JSON.stringify({ version: 1, gatewayUrl: "https://gateway.example", gatewayToken: "test-secret" }));
      expect(readGatewaySession(saved)).toEqual({ baseUrl: "https://gateway.example", token: "test-secret", headers: {} });
      writeFileSync(saved, JSON.stringify({ gatewayUrl: "http://gateway.example", gatewayToken: "test-secret" }));
      expect(() => readGatewaySession(saved)).toThrow("invalid");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("exports only the active account access token from Windows Safe Storage fixtures", () => {
    const key = randomBytes(32);
    const encrypt = (text: string) => {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(text), cipher.final()]);
      return Buffer.concat([Buffer.from("v10"), iv, ciphertext, cipher.getAuthTag()]).toString("base64");
    };
    const saved = { version: 1, "cursor-accounts": JSON.stringify({ active: "a", accounts: { a: {
      "cursor-access-token": encrypt("account-secret"), "cursor-refresh-token": encrypt("refresh-never-exported"), "cursor-selected-team-id": encrypt("123"),
    }, b: { "cursor-access-token": encrypt("other-secret") } } }), "cursor-machine-id": encrypt("machine") };
    expect(backendSession(saved, key)).toEqual(session);
    expect(JSON.stringify(backendSession(saved, key))).not.toContain("refresh");
    expect(backendSession(saved, key, "b").accessToken).toBe("other-secret");
    expect(() => backendSession(saved, key, "missing")).toThrow("selected account");
    expect(backendSession({ "cursor-access-token": `scoped:v1:${"a".repeat(64)}:${encrypt("legacy")}` }, key).accessToken).toBe("legacy");
  });
});
