/**
 * The API the screens bench answers in the page from dev/screensFixtures. Any other request gets an empty success
 * and a console warning, so a screen that starts reading something new shows at once. Never part of the build.
 */

import { direct as DIRECT, directionsOf, timetableOf } from "./screensFixtures";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The stream stays open when the script holds at a moment. */
const sse = (script, signal) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const { event, data } of script.events) {
        await new Promise((r) => setTimeout(r, 40));
        if (signal?.aborted) break;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }
      if (!script.hold || signal?.aborted) controller.close();
      else signal?.addEventListener("abort", () => controller.close());
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
};

const headerOf = (options, name) => {
  const h = options?.headers || {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : "";
};

export function installBenchServer(moment, { history = [] } = {}) {
  const script = DIRECT.scripts[moment] || { events: [] };
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, window.location.href);
    const path = url.pathname.replace(/^.*?\/gtfs(?=\/)/, "");
    const method = (options.method || "GET").toUpperCase();
    const lens = Boolean(headerOf(options, "X-View-Preview"));
    let m;
    if (method === "POST" && path === "/transform/direct") return sse(script, options.signal);
    if ((m = /^\/transform\/preview\/([^/]+)\/diff$/.exec(path))) return m[1] === DIRECT.previewId ? json(DIRECT.diff) : json({ error: "PREVIEW_NOT_FOUND" }, 404);
    if ((m = /^\/directions\/([^/]+)\/(\d{8})$/.exec(path))) return json(directionsOf(decodeURIComponent(m[1]), m[2], lens));
    if ((m = /^\/stops_and_times\/([^/]+)\/([^/]+)\/(\d{8})$/.exec(path))) return json(timetableOf(decodeURIComponent(m[1]), decodeURIComponent(m[2]), m[3], lens));
    if (method === "POST" && path === "/transform/commit") return json({ ok: true, edit_id: 41, version: { n: 3 }, applied: true });
    if (path === "/config/features") return json({ access: { read: "ok", edit: "ok", studio: "ok", model: "open", validator: "ok" }, accounts: { enabled: false, signedIn: false, entitlements: [] }, chat: { enabled: true }, workspace: { enabled: true, retention_days: 30 } });
    if (path === "/edit/history") return json({ entries: [], total: 0, history, since_edit_id: null });
    if (path.startsWith("/edit/")) return json({ ok: true, editing: true });
    console.warn("bench: no fixture for", method, path);
    return json({});
  };
}
