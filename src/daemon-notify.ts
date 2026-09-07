import http from "node:http";
import { dirname, join } from "node:path";
import { kastraEdgeConfigPath } from "./config.js";

// Best-effort IPC to the local
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
  return env.KASTRA_EDGE_DAEMON_SOCKET || join(dirname(kastraEdgeConfigPath(env)), "daemon.sock");
}

// Fire-and-forget: never throws, never hangs past a hard 1s ceiling
// (the 500ms socket timeout is idle-based and resets on each byte).
function post(path: string, body: unknown, socketPath: string): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let req: http.ClientRequest | undefined;
    const finish = () => {
      if (!done) {
        done = true;
        clearTimeout(hardDeadline);
        resolve();
      }
    };
    const hardDeadline = setTimeout(() => {
      req?.destroy();
      finish();
    }, 1000);
    hardDeadline.unref?.();
    try {
      req = http.request(
        { socketPath, path, method: "POST", headers: { "content-type": "application/json" }, timeout: 500 },
        (res) => {
          res.resume();
          res.on("end", finish);
          res.on("error", finish);
        },
      );
      req.on("error", finish);
      req.on("timeout", () => {
        req?.destroy();
        finish();
      });
      req.end(JSON.stringify(body ?? {}));
    } catch {
      req?.destroy();
      finish();
    }
  });
}

export const notifyHold = (n: HoldNotification, socketPath: string = daemonSocketPath()): Promise<void> =>
  post("/v1/notifications/hold", n, socketPath);

export const clearHold = (checkpointId: string, socketPath: string = daemonSocketPath()): Promise<void> =>
  post(`/v1/notifications/hold/${encodeURIComponent(checkpointId)}/clear`, null, socketPath);
