/**
 * aiSummary.test.js — POST /ai/summarize (release notes from the edit log,
 * diff explanation) with a scripted Anthropic SDK, plus the CHANGELOG.md
 * export ride-along.
 */

"use strict";

process.env.NL2SQL_CHAT_ENABLED = "true";
process.env.ANTHROPIC_API_KEY = "test-key-sdk-is-mocked";
process.env.ALLOW_ANTHROPIC_IN_TESTS = "true";
process.env.BETA_GATE_DISABLED = "true";

jest.mock("@anthropic-ai/sdk", () => {
  const calls = [];
  class Anthropic {
    constructor() {
      this.messages = {
        create: async (params) => {
          calls.push(params);
          return {
            content: [{ type: "text", text: `# Release notes\n\n- ${params.system.includes("release notes") ? "changelog" : "diff"} ok` }],
            usage: { input_tokens: 120, output_tokens: 30 },
          };
        },
        stream: () => {
          throw new Error("not used here");
        },
      };
    }
  }
  return { Anthropic, __calls: calls };
});

const { __calls } = require("@anthropic-ai/sdk");
const {
  seedSession,
  teardownSession,
  removeUploadRoot,
  api,
} = require("./_helpers/sampleSession");
const { _internals } = require("../services/aiSummaryService");

describe("POST /ai/summarize", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    teardownSession(sessionId);
    removeUploadRoot();
  });

  test("changelog refuses an empty log, then summarises the edits and stores the notes", async () => {
    let res = await api(sessionId).post("/ai/summarize", { kind: "changelog", language: "fr" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("NO_EDITS");

    await api(sessionId).post("/edit/stops/rename_batch", { renames: [{ stop_id: "DOM", stop_name: "Domino Park (renamed)" }] });
    await api(sessionId).post("/edit/calendar/extend", { end_date: "20271231", service_ids: ["WKD"] });
    res = await api(sessionId).post("/ai/summarize", { kind: "changelog", language: "fr" });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("changelog");
    expect(res.body.markdown).toMatch(/^# Release notes/);
    expect(res.body.stored).toBe(true);
    expect(res.body.edits_total).toBe(2);
    const call = __calls[__calls.length - 1];
    expect(call.system).toMatch(/Write in French/);
    const payload = JSON.parse(call.messages[0].content.replace(/^Edit log \(JSON\):\n/, ""));
    expect(payload.edits.map((e) => e.action)).toEqual(["bulk_update", "bulk_update"]);
    expect(payload.feed.counts.routes).toBeGreaterThan(0);
    // Undone edits drop out of the notes.
    await api(sessionId).undo();
    expect(_internals.buildChangelogPayload(db).edits_total).toBe(1);
  });

  test("the export ships the stored notes as CHANGELOG.md only when asked", async () => {
    const request = require("supertest");
    const app = require("../app");
    const bufferParser = (r, cb) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    };
    const zipNames = (buf) => {
      const s = buf.toString("latin1");
      return { changelog: s.includes("CHANGELOG.md"), stops: s.includes("stops.txt") };
    };
    const withNotes = await request(app).get("/gtfs/edit/export?changelog=1").set("X-Session-ID", sessionId).buffer(true).parse(bufferParser);
    expect(withNotes.status).toBe(200);
    expect(zipNames(withNotes.body)).toEqual({ changelog: true, stops: true });
    const without = await request(app).get("/gtfs/edit/export").set("X-Session-ID", sessionId).buffer(true).parse(bufferParser);
    expect(without.status).toBe(200);
    expect(zipNames(without.body)).toEqual({ changelog: false, stops: true });
  }, 60_000);

  test("diff summaries trim the payload the model sees", async () => {
    const wide = {};
    for (let i = 0; i < 20; i++) wide[`col${i}`] = "x".repeat(200);
    const res = await api(sessionId).post("/ai/summarize", {
      kind: "diff",
      language: "en",
      payload: {
        diff: {
          summary: { added: 3, removed: 1, changed: 2, tablesWithChanges: 2 },
          tables: {
            routes: { added: 3, removed: 0, changed: 0, samples: { added: Array.from({ length: 12 }, () => wide), removed: [], changed: [] } },
            stops: { added: 0, removed: 0, changed: 0, samples: { added: [], removed: [], changed: [] } },
            "bad table": { added: 1 },
          },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.markdown).toContain("diff ok");
    const call = __calls[__calls.length - 1];
    const payload = JSON.parse(call.messages[0].content.replace(/^Feed diff \(JSON\):\n/, ""));
    expect(Object.keys(payload.tables)).toEqual(["routes"]);
    expect(payload.tables.routes.samples.added).toHaveLength(5);
    expect(Object.keys(payload.tables.routes.samples.added[0])).toHaveLength(12);
    expect(payload.tables.routes.samples.added[0].col0.length).toBeLessThan(70);
  });

  test("validates its input", async () => {
    let res = await api(sessionId).post("/ai/summarize", { kind: "poem" });
    expect(res.status).toBe(400);
    res = await api(sessionId).post("/ai/summarize", { kind: "diff" });
    expect(res.status).toBe(400);
  });
});
