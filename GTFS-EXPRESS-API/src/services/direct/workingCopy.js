/**
 * The agent's writes so far, simulated by the engine as one plan of `sql` operations on a sandbox of the feed. Every
 * kept write is replayed in order at each simulation, so the copy is always the plan the commit replays (G6). A write
 * the engine refuses is not kept: its refusal is the tool's answer. The person's feed is only ever read here.
 */

"use strict";

const engine = require("../transform/engine");
const validatorGate = require("../validatorGate");
const { buildFeedModel } = require("../transform/feedModel");

// What one write's answer shows of the diff: the agent reads the rest by query.
const DIFF_LINES = 20;
const MAX_WRITES = 100;

const statementsOf = (v) => (typeof v === "string" ? v.trim() : Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().replace(/;\s*$/, "")).join(";\n") : "");
const expectOf = (v) => {
  if (Number.isInteger(v) && v >= 0) return v;
  if (v && typeof v === "object" && (Number.isInteger(v.min) || Number.isInteger(v.max))) return { ...(Number.isInteger(v.min) ? { min: v.min } : {}), ...(Number.isInteger(v.max) ? { max: v.max } : {}) };
  return null;
};

const changesText = (changes) => {
  const rows = Object.entries(changes || {}).sort(([a], [b]) => a.localeCompare(b));
  return rows.length ? rows.map(([t, c]) => `${t} +${c.inserted} −${c.deleted} ~${c.updated}`).join("; ") : "none";
};

const refusalOf = (step) => {
  const asks = (step?.ambiguities || []).map((a) => a?.message).filter(Boolean);
  return asks.length ? asks.join(" ") : step?.error || step?.summary || "refused";
};

const stateText = (p) => {
  if (!p || p.empty) return "The copy is now the feed as loaded: nothing differs.";
  const lines = Array.isArray(p.lines) ? p.lines : [];
  const out = [`Rows changed against the feed before (added, removed, changed): ${changesText(p.changes)}.`];
  if (lines.length) out.push(`Semantic diff:\n- ${lines.slice(0, DIFF_LINES).join("\n- ")}${lines.length > DIFF_LINES ? `\n… ${lines.length - DIFF_LINES} more: read them by query` : ""}`);
  if ((p.integrity || []).length) out.push(`Integrity broken (the delivery refuses it): ${p.integrity.map((i) => `${i.code} ×${i.count}`).join(", ")}.`);
  return out.join("\n");
};

const createWorkingCopy = ({ db, sessionId = null, dataVersion = null, lang = "en", today = null, country = null }) => {
  let writes = [];
  let preview = null;
  let sandbox = null;
  let model = null;
  let seq = 0;
  const planOf = (list) => ({ title: "Direct change", operations: list.map((w) => ({ id: w.id, type: "sql", params: { statements: w.statements, ...(w.intent ? { intent: w.intent } : {}), ...(w.expect != null ? { expect: w.expect } : {}) } })) });
  const options = (extra = {}) => ({ sessionId, dataVersion, lang, today, validatorEnabled: validatorGate.isAvailable(), ...extra });
  const swap = (p) => {
    const next = p && p.id ? engine.replayPreview(sessionId, p.id, db) : null;
    if (sandbox && sandbox.open) sandbox.close();
    sandbox = next;
    preview = p;
    model = null;
  };

  const copy = {
    get writes() {
      return writes.slice();
    },
    get preview() {
      return preview;
    },
    current: () => sandbox || db,
    before: () => db,
    model: () => {
      if (!model) model = buildFeedModel(copy.current());
      return model;
    },
    async write(input = {}) {
      const statements = statementsOf(input.statements ?? input.sql);
      if (!statements) return { ok: false, text: "statements is required: UPDATE, INSERT or DELETE statements, separated by semicolons." };
      if (writes.length >= MAX_WRITES) return { ok: false, text: `${MAX_WRITES} writes at most in one change: group statements in fewer writes.` };
      seq += 1;
      const w = { id: `w${seq}`, statements, intent: typeof input.intent === "string" ? input.intent.trim().slice(0, 300) : "", expect: expectOf(input.expect) };
      const p = await engine.previewPlan(db, planOf([...writes, w]), options());
      const step = (p.steps || []).find((s) => s.id === w.id);
      // An earlier write cannot stop applying (same statements, same feed); should one, this write is not kept either.
      const others = (p.steps || []).filter((s) => s.id !== w.id && (s.status === "blocked" || s.status === "failed"));
      if (!step || step.status === "blocked" || step.status === "failed" || others.length) return { ok: false, text: `Refused, nothing kept (the copy is as before this write): ${refusalOf(step || others[0])}` };
      if (step.status === "skipped") return { ok: false, text: "These statements change no row: nothing kept." };
      writes = [...writes, w];
      swap(p);
      const warnings = (step.warnings || []).map((x) => (typeof x === "string" ? x : x?.message || x?.text)).filter(Boolean);
      return { ok: true, text: [`Applied (${w.id}).${warnings.length ? ` Warnings: ${warnings.slice(0, 5).join(" ")}` : ""}`, stateText(p)].join("\n") };
    },
    async validated() {
      if (!writes.length) return preview;
      const run = validatorGate.isAvailable() ? (d) => validatorGate.validateDb(d, country) : null;
      const p = await engine.previewPlan(db, planOf(writes), options({ validate: run }));
      swap(p);
      return p;
    },
    async restore(list) {
      writes = (Array.isArray(list) ? list : []).filter((w) => w && typeof w.statements === "string" && /^w\d+$/.test(w.id)).slice(0, MAX_WRITES);
      seq = writes.reduce((m, w) => Math.max(m, Number(w.id.slice(1))), 0);
      if (!writes.length) return swap(null);
      const p = await engine.previewPlan(db, planOf(writes), options());
      // The feed changed under the held turn: the writes are dropped rather than kept half applied.
      if (p.blocked) {
        writes = [];
        return swap(null);
      }
      swap(p);
    },
    close() {
      if (sandbox && sandbox.open) sandbox.close();
      sandbox = null;
      model = null;
    },
  };
  return copy;
};

module.exports = { createWorkingCopy, _internals: { stateText, changesText, refusalOf, statementsOf, expectOf } };
