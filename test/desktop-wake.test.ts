import { describe, expect, it } from "vitest";
import { DesktopMedia } from "../src/desktop/media.js";

const session = { baseUrl: "https://api2.cursor.sh", accessToken: "token", machineId: "machine", clientVersion: "0.77.0" };

describe("desktop cloud computer wake", () => {
  it("calls EnsureSandBox on the account backend with the prod namespace", async () => {
    let seen: { url: string; headers: Record<string, string>; body: unknown } | undefined;
    const media = new DesktopMedia(async () => session, async (input, init) => {
      seen = { url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
      return new Response(null, { status: 200 });
    });
    expect(await media.wake()).toBe(true);
    expect(seen!.url).toBe("https://api2.cursor.sh/aiserver.v1.GrokBotService/EnsureSandBox");
    expect(seen!.headers["x-sand-box-namespace"]).toBe("prod");
    expect(seen!.headers.Authorization).toBe("Bearer token");
    expect(seen!.body).toEqual({ wake: true, supportsAsleepBox: true });
  });

  it("does not contact the backend without an imported account session", async () => {
    let called = false;
    const media = new DesktopMedia(async () => undefined, async () => { called = true; return new Response(null, { status: 200 }); });
    expect(await media.wake()).toBe(false);
    expect(called).toBe(false);
  });

  it("reports failure instead of throwing", async () => {
    const media = new DesktopMedia(async () => session, async () => { throw new Error("offline"); });
    expect(await media.wake()).toBe(false);
  });
});
