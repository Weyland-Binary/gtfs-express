/**
 * networkStudioApi.test.js — the studio's client: SSE parsing of a planner
 * turn, pre-stream error envelopes, the brief file reader and the draft.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../components/edit/BetaGateDialog", () => ({ BETA_CODE_STORAGE_KEY: "beta-code" }));

import { streamPlan, validateSpec, readBriefFile, loadDraft, saveDraft } from "../utils/networkStudioApi";

const sseResponse = (chunks) => {
  const enc = new TextEncoder();
  let i = 0;
  return {
    headers: { get: () => "text/event-stream" },
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { value: enc.encode(chunks[i++]), done: false } : { value: undefined, done: true }),
      }),
    },
  };
};

describe("networkStudioApi", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    localStorage.clear();
  });

  it("streams planner events, tolerating chunk boundaries inside an event", async () => {
    global.fetch.mockResolvedValueOnce(sseResponse(['event: meta\ndata: {"model":"m"}\n\nevent: tok', 'en\ndata: {"text":"Bon"}\n\nevent: spec\ndata: {"ok":true,"spec":{"lines":[]}}\n\n', "event: done\ndata: {\"reason\":\"complete\"}\n\n"]));
    const events = [];
    localStorage.setItem("beta-code", "ABCD");
    await streamPlan({ brief: "x", language: "fr", onEvent: (e, d) => events.push([e, d]) });
    expect(events.map((e) => e[0])).toEqual(["meta", "token", "spec", "done"]);
    expect(events[1][1]).toEqual({ text: "Bon" });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toMatch(/\/network\/plan$/);
    expect(init.headers["X-Beta-Code"]).toBe("ABCD");
    expect(JSON.parse(init.body)).toMatchObject({ brief: "x", language: "fr", messages: [] });
  });

  it("surfaces pre-stream JSON errors with their code", async () => {
    global.fetch.mockResolvedValueOnce({ headers: { get: () => "application/json" }, status: 403, json: async () => ({ error: "FREE_QUOTA_EXHAUSTED", message: "no more" }) });
    await expect(streamPlan({ brief: "x", onEvent: () => {} })).rejects.toMatchObject({ code: "FREE_QUOTA_EXHAUSTED", status: 403 });
    global.fetch.mockResolvedValueOnce({ ok: false, status: 402, json: async () => ({ error: "PLAN_LIMIT", message: "too many lines" }) });
    await expect(validateSpec({})).rejects.toMatchObject({ code: "PLAN_LIMIT", status: 402 });
  });

  it("reads text briefs only, and keeps a draft in localStorage", async () => {
    const txt = new File(["Ligne A: gare, mairie"], "brief.txt", { type: "text/plain" });
    await expect(readBriefFile(txt)).resolves.toBe("Ligne A: gare, mairie");
    const pdf = new File(["%PDF"], "cahier.pdf", { type: "application/pdf" });
    await expect(readBriefFile(pdf)).rejects.toMatchObject({ code: "UNSUPPORTED_FILE" });
    saveDraft({ spec: { lines: [{ short_name: "1" }] }, turns: [] });
    expect(loadDraft().spec.lines[0].short_name).toBe("1");
    saveDraft(null);
    expect(loadDraft()).toBeNull();
  });
});
