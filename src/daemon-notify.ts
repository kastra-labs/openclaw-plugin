import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

// Mirrors kastra-edge/internal/notify/daemon.go: best-effort IPC to the local
// kastra-edge daemon so the popover reacts instantly when OpenClaw runs on the
// same machine. Remote gateways simply no-op (popover still gets MQTT push
// from the backend).
export type HoldNotification = {
  checkpoint_id: string;
  title: string;
  source: string;
  console_url: string;
  expires_at: string;
};

export function daemonSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.KASTRA_EDGE_DAEMON_SOCKET || join(homedir(), ".kastra", "daemon.sock");
}

// Fire-and-forget: never throws, never hangs past ~500ms.
function post(path: string, body: unknown, socketPath: string): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request(
      { socketPath, path, method: "POST", headers: { "content-type": "application/json" }, timeout: 500 },
      (res) => {
        res.resume();
        res.on("end", () => resolve());
        res.on("error", () => resolve());
      },
    );
    req.on("error", () => resolve());
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.end(JSON.stringify(body ?? {}));
  });
}

export const notifyHold = (n: HoldNotification, socketPath: string = daemonSocketPath()): Promise<void> =>
  post("/v1/notifications/hold", n, socketPath);

export const clearHold = (checkpointId: string, socketPath: string = daemonSocketPath()): Promise<void> =>
  post(`/v1/notifications/hold/${checkpointId}/clear`, null, socketPath);
