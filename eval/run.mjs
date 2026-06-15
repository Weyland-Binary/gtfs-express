#!/usr/bin/env node
/**
 * eval/run.mjs — measurable reliability for the AI repair companion.
 *
 * For each golden case (eval/cases.mjs):
 *   1. build an in-memory SQLite feed with the project schema and seed the
 *      deliberate defect;
 *   2. ask the model THROUGH THE REAL CHAT PROMPT (CHAT_SYSTEM_PROMPT +
 *      session-context block, pass-1 contract with the </sql> stop
 *      sequence) the question an operator would ask;
 *   3. execute the generated SQL on the fixture;
 *   4. score: violating-row count must drop to 0 AND the invariant
 *      (no collateral damage) must hold.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node eval/run.mjs [--model claude-sonnet-4-6]
 *
 * Output: eval/results/<timestamp>.json + .md (accuracy report). This is
 * NOT part of CI (it spends real tokens) — run it when touching the prompt,
 * the model choice, or the repair few-shots, and commit the report as the
 * new baseline.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { CASES, seedBase } from "./cases.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(__dirname, "..", "GTFS-EXPRESS-API");
const require = createRequire(path.join(API_DIR, "package.json"));

const Database = require("better-sqlite3");
const { applySchema } = require(
  path.join(API_DIR, "src", "services", "db", "schema.js"),
);
const { Anthropic } = require("@anthropic-ai/sdk");
const nl2sqlService = require(
  path.join(API_DIR, "src", "services", "nl2sqlService.js"),
);

const argModel = process.argv.indexOf("--model");
const MODEL =
  argModel !== -1
    ? process.argv[argModel + 1]
    : process.env.NL2SQL_CHAT_MODEL || "claude-sonnet-4-6";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required.");
  process.exit(1);
}
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Same extraction contract as the chat service (tagged block, stop-sequence
// truncation tolerated, markdown fence fallback).
const extractSql = (text) => {
  const tagged = /<sql>\s*([\s\S]*?)\s*(?:<\/sql>|$)/i.exec(text);
  if (tagged && tagged[1].trim()) return tagged[1].trim();
  const fenced = /```sql\s*([\s\S]*?)```/i.exec(text);
  if (fenced && fenced[1].trim()) return fenced[1].trim();
  return null;
};

const contextBlock = (c) =>
  [
    "[Session context — auto-attached by the app, may lag behind the latest edits]",
    `Validation status: 1 error(s), 0 warning(s), 0 info notice(s). Export is blocked until the errors are fixed.`,
    `Top findings:\n- ${c.rule} (1 error)`,
    "Agency ids: A1.",
  ].join("\n");

const runCase = async (c) => {
  const db = new Database(":memory:");
  applySchema(db);
  // Broken feeds are exactly the state where FK enforcement is off-spec;
  // mirror the rescue-session reality while seeding and repairing. Must run
  // AFTER applySchema, which re-enables foreign keys.
  db.pragma("foreign_keys = OFF");
  seedBase(db);
  c.seed(db);

  const before = c.violating(db);
  if (before === 0) {
    db.close();
    return { id: c.id, ok: false, error: "fixture seeded 0 violations" };
  }

  const t0 = Date.now();
  let sql = null;
  let modelError = null;
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      stop_sequences: ["</sql>"],
      system: [
        {
          type: "text",
          text: nl2sqlService.CHAT_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        { role: "user", content: `${contextBlock(c)}\n\n${c.question}` },
      ],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    sql = extractSql(text);
  } catch (err) {
    modelError = err.message;
  }
  const latencyMs = Date.now() - t0;

  if (!sql) {
    db.close();
    return {
      id: c.id,
      ok: false,
      before,
      error: modelError || "no <sql> block extracted",
      latencyMs,
    };
  }

  let execError = null;
  try {
    db.exec(sql);
  } catch (err) {
    execError = err.message;
  }
  const after = execError == null ? c.violating(db) : before;
  const invariantOk = execError == null ? c.invariant(db) : false;
  db.close();

  return {
    id: c.id,
    rule: c.rule,
    ok: execError == null && after === 0 && invariantOk,
    before,
    after,
    invariantOk,
    execError,
    sql,
    latencyMs,
  };
};

const main = async () => {
  console.log(`AI repair eval — model: ${MODEL}, cases: ${CASES.length}\n`);
  const results = [];
  for (const c of CASES) {
    const r = await runCase(c);
    results.push(r);
    console.log(
      `${r.ok ? "✓" : "✗"} ${c.id.padEnd(28)} before=${r.before ?? "-"} after=${r.after ?? "-"} ` +
        `${r.invariantOk === false ? "INVARIANT-BROKEN " : ""}${r.execError ? `exec: ${r.execError} ` : ""}${r.error || ""}`,
    );
  }

  const passed = results.filter((r) => r.ok).length;
  const accuracy = ((passed / results.length) * 100).toFixed(1);
  console.log(`\nAccuracy: ${passed}/${results.length} (${accuracy}%)`);

  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const payload = {
    ts: new Date().toISOString(),
    model: MODEL,
    passed,
    total: results.length,
    accuracy: Number(accuracy),
    results,
  };
  fs.writeFileSync(
    path.join(outDir, `${stamp}.json`),
    JSON.stringify(payload, null, 2),
  );
  const md = [
    `# AI repair eval — ${payload.ts}`,
    "",
    `Model: \`${MODEL}\` — **${passed}/${results.length} (${accuracy}%)**`,
    "",
    "| Case | Rule | Before → After | Invariant | OK |",
    "|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.rule || "-"} | ${r.before ?? "-"} → ${r.after ?? "-"} | ${
          r.invariantOk === false ? "BROKEN" : "ok"
        } | ${r.ok ? "✓" : `✗ ${r.execError || r.error || ""}`} |`,
    ),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, `${stamp}.md`), md);
  console.log(`Report: eval/results/${stamp}.{json,md}`);
  process.exit(passed === results.length ? 0 : 2);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
