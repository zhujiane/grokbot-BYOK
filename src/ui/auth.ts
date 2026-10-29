import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { page } from "./page.js";

const equal = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export function createUi(token: string, importSession: (value: unknown) => Promise<void>) {
  const username = process.env.UI_USERNAME || "admin", password = process.env.UI_PASSWORD || "";
  const sign = (s: string) => createHmac("sha256", token + "\n" + password).update(s).digest("hex");
  const failures = new Map<string, { count: number; until: number }>();
  function authenticated(req: IncomingMessage) {
    if (!password) return false;
    const cookie = /(?:^|;\s*)grok_ui=([^;]+)/.exec(req.headers.cookie || "")?.[1] || "";
    const [expiry, nonce, mac] = cookie.split(".");
    return /^\d+$/.test(expiry || "") && Number(expiry) > Date.now() && Number(expiry) <= Date.now() + 86400000 &&
      /^[a-f0-9-]{36}$/.test(nonce || "") && equal(mac || "", sign(expiry + "." + nonce));
  }
  function sameOrigin(req: IncomingMessage) {
    try { return new URL(req.headers.origin || "").host === req.headers.host && ["http:", "https:"].includes(new URL(req.headers.origin!).protocol); }
    catch { return false; }
  }
  const reply = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(data));
  };
  async function input(req: IncomingMessage) {
    if (!(req.headers["content-type"] || "").startsWith("application/json")) throw new Error("请使用 JSON 格式");
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) throw new Error("文件超过 256 KiB"); chunks.push(Buffer.from(chunk)); }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  return { authenticated, sameOrigin, async handle(req: IncomingMessage, res: ServerResponse, route: string) {
    if (route === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      res.end(page); return true;
    }
    if (!route.startsWith("/ui/")) return false;
    if (!password) { reply(res, 503, { error: { message: "请配置 UI_PASSWORD 并重启容器" } }); return true; }
    if (req.method !== "GET" && !sameOrigin(req)) { reply(res, 403, { error: { message: "请求来源无效" } }); return true; }
    if (route === "/ui/login" && req.method === "POST") {
      const ip = req.socket.remoteAddress || "unknown", now = Date.now();
      for (const [key, value] of failures) if (value.until <= now) failures.delete(key);
      const failure = failures.get(ip);
      if (failure && failure.count >= 10) { reply(res, 429, { error: { message: "登录尝试过多，请 10 分钟后重试" } }); return true; }
      try {
        const value = await input(req);
        if (typeof value.username !== "string" || typeof value.password !== "string" || !equal(value.username, username) || !equal(value.password, password)) {
          if (failures.size >= 10000 && !failures.has(ip)) { reply(res, 429, { error: { message: "请稍后重试" } }); return true; }
          failures.set(ip, { count: (failure?.count || 0) + 1, until: failure?.until || now + 600000 });
          reply(res, 401, { error: { message: "用户名或密码错误" } }); return true;
        }
        failures.delete(ip);
        const raw = String(now + 86400000) + "." + randomUUID();
        res.setHeader("Set-Cookie", "grok_ui=" + raw + "." + sign(raw) + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400" + (req.socket instanceof (await import("node:tls")).TLSSocket ? "; Secure" : ""));
        reply(res, 200, { authenticated: true });
      } catch { reply(res, 400, { error: { message: "登录请求无效" } }); }
      return true;
    }
    if (!authenticated(req)) { reply(res, 401, { error: { message: "请先登录" } }); return true; }
    if (route === "/ui/session" && req.method === "GET") reply(res, 200, { authenticated: true, username });
    else if (route === "/ui/logout" && req.method === "POST") {
      res.setHeader("Set-Cookie", "grok_ui=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"); reply(res, 200, { ok: true });
    } else if (route === "/ui/credentials" && req.method === "POST") {
      try { await importSession(await input(req)); reply(res, 200, { imported: true }); }
      catch { reply(res, 400, { error: { message: "导入失败：请上传有效的 Grok Bot 会话 JSON，或检查数据目录权限" } }); }
    } else if (route === "/ui/export-session.cjs" && req.method === "GET") {
      try { const script = await readFile("scripts/export-grok-bot-session.cjs"); res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="export-grok-bot-session.cjs"', "Cache-Control": "no-store" }); res.end(script); }
      catch { reply(res, 404, { error: { message: "导出脚本不存在" } }); }
    } else reply(res, 404, { error: { message: "接口不存在" } });
    return true;
  } };
}
