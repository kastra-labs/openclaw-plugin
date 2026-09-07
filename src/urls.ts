// Known SaaS API origins derive their customer console; any other host derives
// nothing (never infer a hosted console for a private deployment). Mirrors
// kastra-edge internal/config.DerivedSaaSConsole.
export function derivedSaaSConsole(apiBaseUrl: string): string {
  switch (apiBaseUrl.replace(/\/+$/, "")) {
    case "https://api.kastra.ai": return "https://app.kastra.ai";
    case "https://api.demo.kastra.ai": return "https://demo.kastra.ai";
  }
  return "";
}

// API origins and reverse-proxy prefixes share this contract across Kastra clients.
// Keep route suffixes intact: callers pass a deployment root, never /api or /v1.
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Invalid base URL: expected an http(s) origin or deployment prefix"); }
  if (!/^https?:\/\/[^/]/i.test(raw) || !["http:", "https:"].includes(url.protocol) || !url.hostname ||
      url.username || url.password || raw.includes("?") || raw.includes("#") || raw.includes("\\") || raw !== raw.trim() || /[\u0000-\u001f\u007f]/.test(raw) || /^https?:\/\/[^/]*@/i.test(raw)) {
    throw new Error("Invalid base URL: credentials, query, fragment and non-http(s) schemes are not supported");
  }
  return url.href.replace(/\/+$/, "");
}
