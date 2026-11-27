/**
 * What the accounts did before the console's product ledgers existed, read once from the events log: the milestones
 * each account had already reached and the turns of its briefs. Without it a trial started before the ledgers would
 * read as one that never opened a network. Read as a stream, oldest file first, after the server has started; the
 * drafts' lives are not in the log and start with the ledger.
 */

"use strict";

const fs = require("fs");
const readline = require("readline");
const config = require("../../config");

const DONE = "product_backfill";
const MILESTONE_OF = Object.freeze({
  "draft.opened": "draft",
  "transform.direct": "brief",
  "transform.commit": "applied",
  "export.completed": "export",
  "workspace.package": "export",
  "workspace.delivered": "export",
  "workspace.member": "invite",
});
const WANTED = [...Object.keys(MILESTONE_OF), "upload"].map((type) => `"type":"${type}"`);

const db = () => require("../accounts/store").getDb();
const count = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.round(Number(n)) : 0);

const filesOf = (file) => [...require("../logRetention").archivesOf(file).sort(), file].filter((p) => fs.existsSync(p));

/** Reads the log and its archives; a milestone keeps its earliest moment, a turn is taken once. */
const run = async ({ file = require("../eventLogger").EVENTS_FILE } = {}) => {
  const database = db();
  const known = database.prepare("SELECT 1 FROM users WHERE id = ?");
  const mark = database.prepare(
    "INSERT INTO account_milestones (user_id, milestone, at) VALUES (?, ?, ?) ON CONFLICT(user_id, milestone) DO UPDATE SET at = MIN(at, excluded.at)",
  );
  const turn = database.prepare(
    `INSERT INTO brief_turns (at, draft_id, user_id, reason, demands, done, not_done, unproven, not_asked, corrections, agent_rounds, reviewer_rounds, duration_ms, failed)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // The turns the ledger recorded itself are not read again from the log.
  const live = (database.prepare("SELECT MIN(at) AS at FROM brief_turns").get() || {}).at || null;
  const out = { milestones: 0, turns: 0 };
  for (const path of filesOf(file)) {
    const rl = readline.createInterface({ input: fs.createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    let batch = [];
    const write = database.transaction((events) => {
      for (const e of events) {
        const data = e.data && e.data.data && typeof e.data.data === "object" ? e.data.data : e.data || {};
        const who = e.user_id || data.user_id || null;
        if (who && !known.get(who)) continue;
        const milestone = e.type === "upload" ? (data.is_sample ? null : "network") : MILESTONE_OF[e.type];
        if (who && milestone) out.milestones += mark.run(who, milestone, e.ts).changes ? 1 : 0;
        if (e.type === "transform.direct" && (!live || e.ts < live)) {
          turn.run(e.ts, who, String(data.reason || "error").slice(0, 20), count(data.demands), count(data.done), count(data.not_done), count(data.unproven), count(data.not_asked), count(data.corrections), count(data.agent_rounds), count(data.reviewer_rounds), count(data.durationMs), data.error || data.agent_error || data.review_error || null);
          out.turns += 1;
        }
      }
    });
    for await (const line of rl) {
      if (!line || !WANTED.some((w) => line.includes(w))) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!e || typeof e.ts !== "string" || typeof e.type !== "string") continue;
      batch.push(e);
      if (batch.length >= 500) {
        write(batch);
        batch = [];
      }
    }
    if (batch.length) write(batch);
  }
  return out;
};

const isDone = () => Boolean(db().prepare("SELECT 1 FROM _meta WHERE key = ?").get(DONE));

/** Once per database, after the start: a log that cannot be read is said and tried again at the next start. */
const start = () => {
  if (!config.ACCOUNTS_ENABLED) return;
  try {
    if (isDone()) return;
  } catch {
    return;
  }
  setImmediate(() => {
    run()
      .then((out) => {
        db().prepare("INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(DONE, new Date().toISOString());
        if (out.milestones || out.turns) console.info(`[product ledger] read from the events log: ${out.milestones} milestone(s), ${out.turns} turn(s) of a brief`);
      })
      .catch((err) => console.warn(`[product ledger] the events log could not be read: ${err.message}`));
  });
};

module.exports = { run, start, _internals: { isDone } };
