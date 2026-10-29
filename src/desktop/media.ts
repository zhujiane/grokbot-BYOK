/** Direct attachment-store reads used by desktop 0.77. No agent prompts. */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ApiError } from "../video/api.js";

export const backendSessionSchema = z.object({
  baseUrl: z.string().url().default("https://api2.cursor.sh"),
  accessToken: z.string().min(1),
  machineId: z.string().min(1).optional(),
  teamId: z.number().int().positive().optional(),
  clientVersion: z.string().default("0.77.0"),
});
export type BackendSession = z.infer<typeof backendSessionSchema>;
export function attachmentAlias(path: string, agentId?: string) {
  try { if (path.startsWith("file:")) path = fileURLToPath(path); } catch { return; }
  const match = /^\/home\/box\/(?:agent-data|sand-data)\/agents\/([^/\\\0]+)\/assets\/([a-f0-9]{64}\.mp4)$/.exec(path);
  if (!match || match[1] !== match[1].trim() || [".", ".."].includes(match[1]) || (agentId !== undefined && match[1] !== agentId)) return;
  return { agentId: match[1], path: `/home/box/agent-data/agents/${match[1]}/assets/${match[2]}` };
}
function checksum(machineId: string) {
  const time = Math.floor(Date.now() / 1e6);
  const b = new Uint8Array([time >> 40 & 255, time >> 32 & 255, time >> 24 & 255, time >> 16 & 255, time >> 8 & 255, time & 255]);
  let previous = 165;
  for (let i = 0; i < b.length; i++) { b[i] = (b[i] ^ previous) + i % 256; previous = b[i]; }
  return Buffer.from(b).toString("base64url") + machineId;
}
const readSchema = z.object({ path: z.string(), outcome: z.union([z.string(), z.number()]), url: z.string().optional(),
  expiresAtMs: z.coerce.number().optional(), sizeBytes: z.coerce.number().optional(), contentType: z.string().optional() });
type StoreRead = { url: string; expires_at: number; size: number; mime: string };

export class DesktopMedia {
  private cache = new Map<string, StoreRead>();
  constructor(private session: () => Promise<BackendSession | undefined>, private fetcher: typeof fetch = fetch) {}
  async resolve(path: string, agentId?: string, fresh = false): Promise<StoreRead | undefined> {
    const alias = attachmentAlias(path, agentId);
    if (!alias) return;
    const session = await this.session();
    if (!session) throw new ApiError(503, "Import the desktop account access token using the exporter --include-backend option; no Bot follow-up will be sent", "desktop_backend_session_missing");
    const base = new URL(session.baseUrl);
    if (base.protocol !== "https:" || !["api2.cursor.sh", "api.origin.cursor.com"].includes(base.hostname) || base.port || base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
      throw new ApiError(503, "Unsupported desktop account backend origin", "desktop_backend_session_invalid");
    }
    // Account changes invalidate cache entries; never reuse another account's signed URL.
    const key = createHash("sha256").update(session.accessToken).digest("hex") + alias.path;
    const cached = this.cache.get(key);
    if (!fresh && cached && cached.expires_at * 1000 > Date.now() + 60000) return cached;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json", "Connect-Protocol-Version": "1",
      "x-cursor-client-type": "sand", "x-cursor-client-version": session.clientVersion,
      "x-sand-box-namespace": "sand", "x-cursor-client-os": "win32", "x-ghost-mode": "true",
    };
    if (session.machineId) headers["x-cursor-checksum"] = checksum(session.machineId);
    if (session.teamId) headers["x-cursor-team-id"] = String(session.teamId);
    const res = await this.fetcher(`${base.origin}/aiserver.v1.GrokBotService/ResolveGrokBotAttachmentReads`, {
      method: "POST", headers, body: JSON.stringify({ agentId: alias.agentId, paths: [alias.path] }),
      redirect: "error", signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new ApiError(res.status === 401 || res.status === 403 ? 503 : 502,
        `Desktop attachment resolver returned HTTP ${res.status}; re-export account credentials if expired`, "desktop_attachment_resolver_error");
    }
    const raw = await this.smallBody(res, 1024 * 1024);
    const value = z.object({ reads: z.array(readSchema) }).parse(JSON.parse(raw.toString("utf8"))).reads.find(r => r.path === alias.path);
    if (!value || !["STORE", "GROK_BOT_ATTACHMENT_READ_OUTCOME_STORE", 1].includes(value.outcome)) return;
    let url: URL;
    try { url = new URL(value.url ?? ""); } catch { throw new ApiError(502, "Invalid attachment store URL", "upstream_error"); }
    const size = value.sizeBytes ?? 0, expires = value.expiresAtMs ?? 0;
    if (url.protocol !== "https:" || url.username || url.password || !Number.isSafeInteger(size) || size <= 0 || size > 1024 ** 3 || !Number.isSafeInteger(expires) || expires <= Date.now()) {
      throw new ApiError(502, "Invalid attachment store metadata", "upstream_error");
    }
    const mime = value.contentType || "video/mp4";
    if (!["video/mp4", "application/octet-stream"].includes(mime)) throw new ApiError(502, "Store attachment is not an MP4", "invalid_video");
    const result = { url: url.href, size, expires_at: Math.floor(expires / 1000), mime };
    if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, result);
    return result;
  }
  private async smallBody(res: Response, limit: number) {
    const chunks: Buffer[] = []; let size = 0;
    for await (const bytes of res.body ?? []) { size += bytes.length; if (size > limit) throw new ApiError(502, "Attachment response exceeds limit", "upstream_error"); chunks.push(Buffer.from(bytes)); }
    return Buffer.concat(chunks);
  }
  async chunk(path: string, agentId: string | undefined, offset: number, length: number) {
    let source = await this.resolve(path, agentId);
    if (!source) return null;
    if (length === 0) return { bytesBase64: "", totalSize: source.size, mime: source.mime };
    const end = Math.min(source.size, offset + length) - 1;
    let res: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      // The signed URL carries its own authorization. Never send desktop credentials to storage.
      res = await this.fetcher(source.url, { headers: { Range: `bytes=${offset}-${end}` }, redirect: "error", signal: AbortSignal.timeout(30000) });
      if (res.status !== 403 || attempt) break;
      await res.body?.cancel(); source = await this.resolve(path, agentId, true);
      if (!source) return null;
    }
    if (!res || (res.status !== 206 && !(res.status === 200 && offset === 0 && end + 1 === source.size))) {
      await res?.body?.cancel(); throw new ApiError(502, "Attachment store range read failed", "upstream_error");
    }
    const bytes = await this.smallBody(res, end - offset + 1);
    if (bytes.length !== end - offset + 1 || (res.status === 206 && res.headers.get("content-range") !== `bytes ${offset}-${end}/${source.size}`)) throw new ApiError(502, "Invalid attachment store range", "upstream_error");
    return { bytesBase64: bytes.toString("base64"), totalSize: source.size, mime: source.mime };
  }
}
