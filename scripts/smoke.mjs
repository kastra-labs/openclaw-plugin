// Usage: node scripts/smoke.mjs ['<shell command>']
// Requires: npm run build; kastra-edge login done on this machine.
import { createBeforeToolCallHandler } from "../dist/handler.js";

const command = process.argv[2] ?? 'gog gmail send --to test@example.com --subject "hi" --body "hello"';
const handler = createBeforeToolCallHandler();
console.log(`[smoke] evaluating: exec → ${command}`);
const res = await handler(
  { toolName: "exec", params: { command } },
  { sessionKey: "smoke-test", agentId: "main", messageProvider: "cli" },
);
console.log("[smoke] result:", res ?? "(allowed)");
