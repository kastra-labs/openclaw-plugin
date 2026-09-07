import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { clearHold, notifyHold, daemonSocketPath } from "./daemon-notify.js";

const sockDir = mkdtempSync(join(tmpdir(), "kastra-sock-"));
const sockPath = join(sockDir, "daemon.sock");
const received: Array<{ url: string; body: string }> = [];

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ url: req.url ?? "", body });
    res.writeHead(200).end("{}");
  });
});
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Timed out binding test daemon socket")), 5000);
  server.once("error", (error) => { clearTimeout(timer); reject(error); });
  server.listen(sockPath, () => { clearTimeout(timer); resolve(); });
});
afterAll(() => new Promise<void>((resolve) => {
  server.closeAllConnections();
  server.close(() => resolve());
}));

describe("daemon notify", () => {
  it("POSTs hold notification to the daemon socket", async () => {
    await notifyHold(
      { checkpoint_id: "cp1", title: "Send email", source: "openclaw", console_url: "https://app.kastra.ai/approvals?checkpoint=cp1", expires_at: "2026-06-12T12:00:00Z" },
      sockPath,
    );
    const hit = received.find((r) => r.url === "/v1/notifications/hold");
    expect(hit).toBeDefined();
    expect(JSON.parse(hit!.body)).toMatchObject({ checkpoint_id: "cp1", source: "openclaw" });
  });

  it("POSTs clear", async () => {
    await clearHold("cp1", sockPath);
    expect(received.some((r) => r.url === "/v1/notifications/hold/cp1/clear")).toBe(true);
  });

  it("escapes checkpoint IDs in the clear route", async () => {
    await clearHold("cp/1?scope=x", sockPath);
    expect(received.some(r => r.url === "/v1/notifications/hold/cp%2F1%3Fscope%3Dx/clear")).toBe(true);
  });

  it("contains synchronous HTTP construction failures without leaving a timer", async () => {
    vi.useFakeTimers();
    const request = vi.spyOn(http, "request").mockImplementation(() => { throw new Error("IPC construction failed"); });
    try {
      await expect(clearHold("cp1", sockPath)).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      request.mockRestore();
    }
  });

  it("resolves silently when the socket is missing", async () => {
    await expect(
      notifyHold({ checkpoint_id: "x", title: "t", source: "openclaw", console_url: "", expires_at: "" }, "/nonexistent/daemon.sock"),
    ).resolves.toBeUndefined();
  });
});

it("uses the selected config directory for daemon IPC",()=>{
 expect(daemonSocketPath({KASTRA_CONFIG:"/private/kastra/config.toml"})).toBe("/private/kastra/daemon.sock");
 expect(()=>daemonSocketPath({KASTRA_EDGE_CONFIG:"/legacy/config.toml"})).toThrow("no longer read");
 expect(daemonSocketPath({XDG_CONFIG_HOME:"/config"})).toBe("/config/kastra/daemon.sock");
 expect(daemonSocketPath({KASTRA_EDGE_DAEMON_SOCKET:"/explicit.sock",KASTRA_CONFIG:"one",KASTRA_EDGE_CONFIG:"two"})).toBe("/explicit.sock");
 expect(()=>daemonSocketPath({KASTRA_CONFIG:"one",KASTRA_EDGE_CONFIG:"two"})).toThrow("no longer read");
});
