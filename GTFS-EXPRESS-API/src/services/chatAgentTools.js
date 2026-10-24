/**
 * The reader's assistant's tools: each a model definition and an executor whose `content` goes back to the model and
 * whose `ctx.emit` events the UI renders. The assistant reads: no tool writes the feed. A change asked of it becomes a
 * brief the person may prepare in a draft (suggest_change), where the direct mode's agent makes it and an independent
 * review measures it. Every input is untrusted: identifiers validated, SQL read-only through the console's classifier,
 * sizes capped before the model or the browser.
 */

"use strict";

const sqlConsoleService = require("./edit/sqlConsoleService");
const validationReportStore = require("./validationReportStore");
const qualityAuditService = require("./qualityAuditService");
const journeyService = require("./journeyService");
const assistantMemoryService = require("./assistantMemoryService");
const { getRule } = require("../utils/rulesCatalog");

// ── Caps ──────────────────────────────────────────────────────────────────
const MODEL_SAMPLE_ROWS = 30; // rows the model sees per query
const MODEL_SAMPLE_BYTES = 6 * 1024; // …bounded in bytes too
const UI_PREVIEW_ROWS = 50; // rows the chat table shows
const CHART_MAX_ROWS = 200; // rows a chart may plot
const KEPT_ROWS = 2000; // rows kept per step for a later chart
const FINDINGS_MAX = 25;
const MAX_SQL_CHARS = 8000;

const SAFE_ID_RE = /^[^\x00-\x1f\x7f]{1,128}$/;
const RULE_CODE_RE = /^[a-z0-9_]{1,64}$/i;

const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s);

// Bounded JSON snapshot of a SQL result for the model.
const resultSnapshot = ({ columns, rows, rowCount, truncated }) => {
  let sample = rows.slice(0, MODEL_SAMPLE_ROWS);
  let payload = JSON.stringify({ rowCount, truncated, columns, sampleRows: sample });
  while (payload.length > MODEL_SAMPLE_BYTES && sample.length > 3) {
    sample = sample.slice(0, Math.ceil(sample.length / 2));
    payload = JSON.stringify({
      rowCount,
      truncated: true,
      columns,
      sampleRows: sample,
      note: "Sample shortened to fit the size budget.",
    });
  }
  if (payload.length > MODEL_SAMPLE_BYTES) {
    payload = JSON.stringify({
      rowCount,
      truncated: true,
      columns,
      note: `Rows are too wide to include. ${rowCount} rows × ${columns.length} columns; first columns: ${columns.slice(0, 8).join(", ")}.`,
    });
  }
  return payload;
};

// ── run_sql ───────────────────────────────────────────────────────────────
// The tables that name people (the journal's actors, the acknowledgements' names): the model never reads
// them (llm/personalData.PERSONAL_TABLES), whatever the query's form — quoted, aliased, in a sub-query.
const PERSONAL_TABLE_RE = new RegExp(`(?<![A-Za-z0-9_])(?:${require("./llm/personalData").PERSONAL_TABLES.join("|")})(?![A-Za-z0-9_])`, "i");
const runSql = {
  definition: {
    name: "run_sql",
    description:
      "Run ONE read-only SQLite query (SELECT / WITH … SELECT) against the loaded GTFS feed and get its result (row count, columns, a sample of rows). The user sees the query and a table of the first rows. Mutations are refused: a change goes through suggest_change.",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SQLite SELECT statement." },
        purpose: {
          type: "string",
          description:
            "Very short label of what this query checks, shown to the user (e.g. 'Trips per route', 'Stops with no name').",
        },
      },
      required: ["sql"],
    },
  },
  // Asynchronous: the query runs in the SQL sandbox (edit/sqlSandbox), out of the API's process, under a time limit.
  async run(input, ctx) {
    const sql = typeof input?.sql === "string" ? input.sql.trim() : "";
    const purpose = clip(typeof input?.purpose === "string" ? input.purpose.trim() : "", 80);
    if (!sql) return { content: "Error: sql is required.", isError: true };
    if (sql.length > MAX_SQL_CHARS) {
      return { content: `Error: query is too long (max ${MAX_SQL_CHARS} chars).`, isError: true };
    }
    const stepId = ctx.nextStepId();
    const parsed = sqlConsoleService.parseStatements(sql, { allowMutations: false });
    if (!parsed.ok) {
      const isMutation = /Mutations are not allowed/i.test(parsed.error || "");
      ctx.emit("step_start", { stepId, kind: "sql", sql, purpose });
      ctx.emit("step_result", {
        stepId,
        kind: "sql",
        error: isMutation
          ? "The assistant reads the feed: a change is prepared from a brief."
          : parsed.error,
      });
      return {
        content: isMutation
          ? "Refused: the assistant never changes the feed. Call suggest_change with the change written as a brief (and this statement as its sql)."
          : `SQL rejected: ${parsed.error}`,
        isError: true,
      };
    }
    if (PERSONAL_TABLE_RE.test(sql)) {
      // The journal and the acknowledgements name people: never read for the model (llm/personalData).
      ctx.emit("step_start", { stepId, kind: "sql", sql, purpose });
      ctx.emit("step_result", { stepId, kind: "sql", error: "The edit journal and the acknowledgements are not read by the assistant." });
      return { content: "Refused: the tables _edit_log and _acknowledgements name people and are not readable from the chat. Answer from the feed's tables.", isError: true };
    }
    ctx.emit("step_start", { stepId, kind: "sql", sql, purpose });
    const t0 = Date.now();
    const exec = await sqlConsoleService.executeSqlReadOnly(ctx.dbCtx, sql);
    if (exec.status >= 400) {
      const message = exec.body?.message || exec.body?.error || "SQL execution failed.";
      ctx.emit("step_result", { stepId, kind: "sql", error: message, durationMs: Date.now() - t0 });
      return { content: `SQL error: ${message}\nFix the query and try again.`, isError: true };
    }
    const body = exec.body || {};
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const columns = Array.isArray(body.columns) ? body.columns : [];
    const rowCount = body.rowCount ?? rows.length;
    const truncated = Boolean(body.truncated);
    ctx.steps.set(stepId, { sql, purpose, columns, rows: rows.slice(0, KEPT_ROWS), rowCount });
    ctx.emit("step_result", {
      stepId,
      kind: "sql",
      rowCount,
      columns,
      rowsPreview: rows.slice(0, UI_PREVIEW_ROWS),
      truncated: truncated || rows.length > UI_PREVIEW_ROWS,
      durationMs: body.duration_ms ?? Date.now() - t0,
    });
    return {
      content: `step_id: ${stepId}\n${resultSnapshot({ columns, rows, rowCount, truncated })}`,
    };
  },
};

// ── get_validation_findings ───────────────────────────────────────────────
const weightOf = (f) => (f && f.aggregate ? Math.max(0, Number(f.aggregateCount) || 0) : 1);
const severityOf = (f) => (f && (f.severity === "warning" || f.severity === "info") ? f.severity : "error");

const summarizeStoredReport = (report) => {
  const byRule = new Map();
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const [file, findings] of Object.entries(report?.errors || {})) {
    if (!Array.isArray(findings)) continue;
    for (const f of findings) {
      if (!f || f.resolvedByImport) continue;
      const w = weightOf(f);
      const sev = severityOf(f);
      if (sev === "error") errors += w;
      else if (sev === "warning") warnings += w;
      else infos += w;
      const code = f.ruleCode || "unknown";
      const cur = byRule.get(code) || { code, severity: sev, count: 0, files: new Set() };
      cur.count += w;
      cur.files.add(file);
      byRule.set(code, cur);
    }
  }
  return {
    errors,
    warnings,
    infos,
    rules: [...byRule.values()]
      .map((r) => ({ ...r, files: [...r.files] }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
  };
};

const getValidationFindings = {
  definition: {
    name: "get_validation_findings",
    description:
      "The latest validation report of this feed (MobilityData canonical validator). Without rule_code: counts per severity and per rule. With rule_code: the sampled findings of that rule (file, entity type and id, field, line, message) so you can inspect and fix the exact rows.",
    input_schema: {
      type: "object",
      properties: {
        rule_code: { type: "string", description: "A rule code such as invalid_color." },
        limit: { type: "integer", description: `Max findings to return (default 15, max ${FINDINGS_MAX}).` },
      },
    },
  },
  run(input, ctx) {
    const stored = validationReportStore.loadReport(ctx.dbCtx.sessionId);
    if (!stored) {
      return {
        content:
          "No validation report is available for this session yet. Ask the user to run the validation (Validate button) — or answer from the data with run_sql.",
      };
    }
    const report = stored.report;
    const summary = summarizeStoredReport(report);
    const code = typeof input?.rule_code === "string" ? input.rule_code.trim() : "";
    const ageMin = Math.round((Date.now() - (stored.savedAt || Date.now())) / 60000);
    const header = `Report from ${ageMin} min ago: ${summary.errors} error(s), ${summary.warnings} warning(s), ${summary.infos} info. Export is ${summary.errors > 0 ? "blocked until the errors are fixed" : "allowed"}.`;
    if (!code) {
      const rules = summary.rules.slice(0, 40).map((r) => `- ${r.code} (${r.severity}): ${r.count} in ${r.files.join(", ")}`);
      return { content: [header, rules.length ? "Rules:" : "No outstanding finding.", ...rules].join("\n") };
    }
    if (!RULE_CODE_RE.test(code)) return { content: "Error: invalid rule_code.", isError: true };
    const limit = Math.min(FINDINGS_MAX, Math.max(1, parseInt(input?.limit, 10) || 15));
    const items = [];
    let total = 0;
    for (const [file, findings] of Object.entries(report.errors || {})) {
      if (!Array.isArray(findings)) continue;
      for (const f of findings) {
        if (!f || f.resolvedByImport || f.ruleCode !== code) continue;
        total += weightOf(f);
        if (f.aggregate) continue;
        if (items.length < limit) {
          items.push({
            file,
            severity: severityOf(f),
            entityType: f.entityType || null,
            entityId: f.entityId != null ? String(f.entityId) : null,
            field: f.field || null,
            line: f.lineNumber ?? f.csvRowNumber ?? null,
            message: clip(typeof f.context === "string" ? f.context : f.message || "", 240),
          });
        }
      }
    }
    if (total === 0) return { content: `${header}\nNo outstanding finding for rule ${code}.` };
    const rule = getRule(code);
    return {
      content: [
        header,
        `Rule ${code}: ${total} finding(s)${rule?.description ? ` — ${rule.description}` : ""}.`,
        `Sample (${items.length}):`,
        JSON.stringify(items),
      ].join("\n"),
    };
  },
};

// ── get_rule_info ─────────────────────────────────────────────────────────
const getRuleInfo = {
  definition: {
    name: "get_rule_info",
    description: "Meaning, default severity and GTFS section of a validation rule code.",
    input_schema: {
      type: "object",
      properties: { rule_code: { type: "string" } },
      required: ["rule_code"],
    },
  },
  run(input) {
    const code = typeof input?.rule_code === "string" ? input.rule_code.trim() : "";
    if (!RULE_CODE_RE.test(code)) return { content: "Error: invalid rule_code.", isError: true };
    const rule = getRule(code);
    if (!rule) {
      return {
        content: `Rule ${code} is not in the catalogue. It may be a validator notice this app does not document; explain it from the MobilityData rule name.`,
      };
    }
    return {
      content: JSON.stringify({
        code,
        severity: rule.default_severity,
        section: rule.gtfs_section,
        description: rule.description,
        mobilitydata_rule: rule.mobilitydata_match || code,
        docs: `https://gtfs-validator.mobilitydata.org/rules.html#${rule.mobilitydata_match || code}`,
      }),
    };
  },
};

// ── get_feed_overview ─────────────────────────────────────────────────────
const OVERVIEW_TABLES = [
  "agency",
  "routes",
  "stops",
  "trips",
  "stop_times",
  "calendar",
  "calendar_dates",
  "shapes",
  "frequencies",
  "transfers",
  "pathways",
  "levels",
  "feed_info",
  "fare_attributes",
  "fare_rules",
  "fare_products",
  "attributions",
  "translations",
];

const getFeedOverview = {
  definition: {
    name: "get_feed_overview",
    description:
      "Orientation snapshot of the loaded feed: row counts per table, agencies, service date range, route type breakdown, shape coverage, feed_info. Cheap — call it before exploring an unfamiliar feed.",
    input_schema: { type: "object", properties: {} },
  },
  run(_input, ctx) {
    const db = ctx.dbCtx.db;
    const q = (sql) => {
      try {
        return db.prepare(sql).all();
      } catch {
        return [];
      }
    };
    const one = (sql) => q(sql)[0] || {};
    const counts = {};
    for (const table of OVERVIEW_TABLES) {
      const row = one(`SELECT COUNT(*) AS n FROM ${table}`);
      if (row.n != null) counts[table] = row.n;
    }
    counts.distinct_shapes = one("SELECT COUNT(DISTINCT shape_id) AS n FROM shapes").n ?? 0;
    const agencies = q("SELECT agency_id, agency_name, agency_timezone, agency_lang FROM agency LIMIT 10");
    const routeTypes = q(
      "SELECT route_type, COUNT(*) AS routes FROM routes GROUP BY route_type ORDER BY routes DESC",
    );
    const cal = one("SELECT MIN(start_date) AS min_start, MAX(end_date) AS max_end FROM calendar");
    const calDates = one(
      "SELECT MIN(date) AS min_date, MAX(date) AS max_date, COUNT(*) AS n FROM calendar_dates",
    );
    const feedInfo = one(
      "SELECT feed_publisher_name, feed_lang, feed_start_date, feed_end_date, feed_version FROM feed_info LIMIT 1",
    );
    const tripsWithoutShape = one(
      "SELECT COUNT(*) AS n FROM trips WHERE shape_id IS NULL OR shape_id = ''",
    ).n;
    const stopsNoCoords = one(
      "SELECT COUNT(*) AS n FROM stops WHERE stop_lat IS NULL OR stop_lat = '' OR stop_lon IS NULL OR stop_lon = ''",
    ).n;
    return {
      content: JSON.stringify({
        counts,
        agencies,
        route_types: routeTypes,
        service_dates: {
          calendar: cal,
          calendar_dates: calDates,
        },
        feed_info: feedInfo,
        quality_hints: {
          trips_without_shape: tripsWithoutShape,
          stops_without_coordinates: stopsNoCoords,
        },
      }),
    };
  },
};

// ── navigate ──────────────────────────────────────────────────────────────
const NAV_TARGETS = new Set([
  "route",
  "stop",
  "trip",
  "shape",
  "validation",
  "schedule",
  "sql_console",
  "shape_studio",
  "home",
]);
const ENTITY_TABLE = {
  route: ["routes", "route_id"],
  stop: ["stops", "stop_id"],
  trip: ["trips", "trip_id"],
  shape: ["shapes", "shape_id"],
};

const navigate = {
  definition: {
    name: "navigate",
    description:
      "Open something in the app for the user: an entity's detail panel (route, stop, trip, shape — give its id), the schedule & map of a route (target 'schedule' + route_id), the validation report, the SQL console, the shape studio of a route (edit mode only), or the home dashboard. Use it when the user asks to see or open something, or to point at the entity you just discussed.",
    input_schema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: [...NAV_TARGETS],
        },
        id: { type: "string", description: "Entity id for route/stop/trip/shape targets." },
        route_id: { type: "string", description: "Route to show for schedule / shape_studio targets." },
      },
      required: ["target"],
    },
  },
  run(input, ctx) {
    const target = typeof input?.target === "string" ? input.target : "";
    if (!NAV_TARGETS.has(target)) return { content: "Error: unknown target.", isError: true };
    const id = typeof input?.id === "string" ? input.id.trim() : "";
    const routeId = typeof input?.route_id === "string" ? input.route_id.trim() : "";
    if (id && !SAFE_ID_RE.test(id)) return { content: "Error: invalid id.", isError: true };
    if (routeId && !SAFE_ID_RE.test(routeId)) return { content: "Error: invalid route_id.", isError: true };
    const db = ctx.dbCtx.db;
    const exists = (table, col, value) => {
      try {
        return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE ${col} = ? LIMIT 1`).get(value));
      } catch {
        return false;
      }
    };
    let label = target;
    let payload = { target };
    if (ENTITY_TABLE[target]) {
      if (!id) return { content: `Error: id is required for target ${target}.`, isError: true };
      const [table, col] = ENTITY_TABLE[target];
      if (!exists(table, col, id)) {
        return { content: `Not found: no ${target} with id "${id}" in this feed.`, isError: true };
      }
      payload = { target, id };
      // Routes deep-link to the schedule & map as well.
      if (target === "route") {
        const r = db.prepare("SELECT agency_id FROM routes WHERE route_id = ?").get(id);
        payload.agencyId = r?.agency_id || null;
      }
      if (target === "trip") {
        const r = db.prepare("SELECT route_id FROM trips WHERE trip_id = ?").get(id);
        payload.routeId = r?.route_id || null;
      }
      label = `${target} ${id}`;
    } else if (target === "schedule" || target === "shape_studio") {
      if (routeId) {
        if (!exists("routes", "route_id", routeId)) {
          return { content: `Not found: no route with id "${routeId}".`, isError: true };
        }
        const r = db.prepare("SELECT agency_id FROM routes WHERE route_id = ?").get(routeId);
        payload = { target, routeId, agencyId: r?.agency_id || null };
        label = `${target} · route ${routeId}`;
      } else {
        payload = { target };
      }
      if (target === "shape_studio" && !ctx.dbCtx.editing) {
        payload.requiresEditMode = true;
      }
    }
    ctx.emit("ui_action", { actionId: ctx.nextActionId(), ...payload, label });
    return {
      content:
        target === "shape_studio" && payload.requiresEditMode
          ? "Opened the request; the Shape Studio needs edit mode, the app asks the user to enable it."
          : `Opened ${label} in the app.`,
    };
  },
};

// ── show_chart ────────────────────────────────────────────────────────────
const CHART_TYPES = new Set(["bar", "line", "pie"]);

const showChart = {
  definition: {
    name: "show_chart",
    description:
      "Draw a chart in the chat from the rows of a previous run_sql step (use its step_id). x is the category/time column; y one or more numeric columns. Keep ≤ 200 rows (aggregate first). pie needs exactly one y column.",
    input_schema: {
      type: "object",
      properties: {
        step_id: { type: "string" },
        chart_type: { type: "string", enum: [...CHART_TYPES] },
        x: { type: "string", description: "Column for the X axis / categories." },
        y: { type: "array", items: { type: "string" }, description: "Numeric column(s) to plot." },
        title: { type: "string" },
      },
      required: ["step_id", "chart_type", "x", "y"],
    },
  },
  run(input, ctx) {
    const stepId = typeof input?.step_id === "string" ? input.step_id : "";
    const step = ctx.steps.get(stepId);
    if (!step) return { content: `Error: unknown step_id "${stepId}". Run the query first.`, isError: true };
    const type = CHART_TYPES.has(input?.chart_type) ? input.chart_type : "bar";
    const x = typeof input?.x === "string" ? input.x : "";
    const y = Array.isArray(input?.y) ? input.y.filter((c) => typeof c === "string") : [];
    const title = clip(typeof input?.title === "string" ? input.title.trim() : "", 80);
    const cols = new Set(step.columns);
    if (!cols.has(x)) return { content: `Error: column "${x}" is not in the result.`, isError: true };
    const missing = y.filter((c) => !cols.has(c));
    if (y.length === 0 || missing.length) {
      return { content: `Error: y column(s) missing from the result: ${missing.join(", ") || "(none given)"}.`, isError: true };
    }
    if (type === "pie" && y.length !== 1) return { content: "Error: pie needs exactly one y column.", isError: true };
    const rows = step.rows.slice(0, CHART_MAX_ROWS).map((r) => {
      const out = { [x]: r[x] };
      for (const c of y) out[c] = Number(r[c]);
      return out;
    });
    ctx.emit("chart", {
      chartId: ctx.nextChartId(),
      stepId,
      chartType: type,
      x,
      y,
      title,
      rows,
      truncated: step.rows.length > CHART_MAX_ROWS,
    });
    return { content: `Chart drawn (${rows.length} points).` };
  },
};

// ── run_quality_audit ─────────────────────────────────────────────────────
const runQualityAudit = {
  definition: {
    name: "run_quality_audit",
    description:
      "Semantic quality audit of the feed, beyond the validator: unrealistic speeds between stops, zero travel times, long dwells, trips with one stop, duplicate stops a few metres apart, inconsistent or ALL-CAPS stop names, shapes far from their stops, services that never run or expired feeds, routes without trips, unused stops, trips without shape, unreadable route colours. Returns findings with counts and sample entities. Use it for 'what is wrong', 'audit', 'quality' questions and before a bulk repair.",
    input_schema: { type: "object", properties: {} },
  },
  run(_input, ctx) {
    const audit = qualityAuditService.auditForSession(ctx.dbCtx.db, ctx.dbCtx.sessionId);
    const ignored = new Set(assistantMemoryService.load(ctx.dbCtx.sessionId).ignoredFindings);
    const findings = audit.findings.map((f) => ({
      code: f.code,
      ...(ignored.has(f.code) ? { ignored_by_user: true } : {}),
      severity: f.severity,
      count: f.count,
      unit: f.unit,
      fix: f.fix,
      samples: f.samples.slice(0, 5).map((s) => ({ id: s.id, label: s.label, detail: s.detail, routeId: s.routeId || undefined })),
      meta: f.meta,
    }));
    ctx.emit("audit", { counts: audit.counts, codes: findings.map((f) => f.code) });
    return {
      content: JSON.stringify({
        generated_at: audit.generatedAt,
        partial: audit.partial,
        counts: audit.counts,
        findings,
        note:
          findings.length === 0
            ? "No semantic issue found."
            : "Explain each finding in plain words and show its rows with run_sql when useful; when the user wants it fixed, call suggest_change with the fix written as a brief. ignored_by_user=true: the user muted this finding: do not bring it up unless asked.",
      }),
    };
  },
};

// ── get_stop_name_variants ────────────────────────────────────────────────
const VARIANT_GROUPS_MAX = 40;
const getStopNameVariants = {
  definition: {
    name: "get_stop_name_variants",
    description:
      "Groups of stops whose names are the same once case, accents, punctuation and spacing are ignored, with every spelling and the stops using it. Use it to show inconsistent spellings: name the best spelling per group (correct case and accents, no abbreviations or trailing codes); a harmonisation the user wants goes through suggest_change.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "integer", description: `Max groups (default 25, max ${VARIANT_GROUPS_MAX}).` } },
    },
  },
  run(input, ctx) {
    const limit = Math.min(VARIANT_GROUPS_MAX, Math.max(1, parseInt(input?.limit, 10) || 25));
    const groups = new Map();
    for (const s of ctx.dbCtx.db.prepare("SELECT stop_id, stop_name FROM stops WHERE stop_name IS NOT NULL AND stop_name != ''").iterate()) {
      const key = qualityAuditService._internals.normalizeName(s.stop_name);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, new Map());
      const variants = groups.get(key);
      if (!variants.has(s.stop_name)) variants.set(s.stop_name, []);
      variants.get(s.stop_name).push(s.stop_id);
    }
    const out = [];
    for (const [key, variants] of groups) {
      if (variants.size < 2) continue;
      out.push({
        key,
        variants: [...variants.entries()].map(([name, ids]) => ({ name, stops: ids.length, stop_ids: ids.slice(0, 20) })),
      });
    }
    out.sort((a, b) => b.variants.length - a.variants.length || a.key.localeCompare(b.key));
    return {
      content: JSON.stringify({ groups: out.length, shown: Math.min(out.length, limit), items: out.slice(0, limit) }),
    };
  },
};

// ── plan_journey ──────────────────────────────────────────────────────────
const planJourney = {
  definition: {
    name: "plan_journey",
    description:
      "Simulate a passenger journey inside THIS feed: earliest-arrival itinerary between two stops on a date and time (services of the day, transfers, walking between nearby stops, frequency trips expanded). Returns the legs with times and routes, or why the trip cannot be made (no service that day, nothing leaves the origin, no connection in the window, tight connection). Use it to check that an edit did not break a link ('can one still get from A to B on Sunday morning?'), to test a new trip, or to answer 'how do I go from X to Y'. Resolve stop ids with run_sql first.",
    input_schema: {
      type: "object",
      properties: {
        from_stop_id: { type: "string" },
        to_stop_id: { type: "string" },
        date: { type: "string", description: "YYYYMMDD (default: today)." },
        time: { type: "string", description: "Departure time HH:MM (default 08:00)." },
        window_hours: { type: "integer", description: "How long after `time` departures are considered (default 4, max 12)." },
      },
      required: ["from_stop_id", "to_stop_id"],
    },
  },
  run(input, ctx) {
    const result = journeyService.planJourney(ctx.dbCtx.db, {
      from_stop_id: input?.from_stop_id,
      to_stop_id: input?.to_stop_id,
      date: input?.date,
      time: input?.time,
      window_hours: input?.window_hours,
    });
    if (!result.ok) return { content: `Cannot plan the journey: ${result.error}`, isError: true };
    const journey = { ...result };
    delete journey.ok;
    ctx.emit("journey", { journeyId: ctx.nextJourneyId(), ...journey });
    if (!journey.reachable) {
      return {
        content: [
          `No itinerary from ${journey.from.stop_name} (${journey.from.stop_id}) to ${journey.to.stop_name} (${journey.to.stop_id}) on ${journey.date} from ${journey.time} within ${journey.window_hours} h.`,
          `Active services that day: ${journey.active_services}. Diagnostics: ${journey.diagnostics.join(", ") || "none"}.`,
          "Explain the diagnostic to the user in plain words (no_service_on_date: the calendars do not cover that date; origin_unserved / destination_unserved: no trip serves that stop in the window; no_connection_in_window: both are served but no chain of trips links them in time). Check the calendars or the trips with run_sql if useful.",
        ].join("\n"),
      };
    }
    const it = journey.itinerary;
    const legs = it.legs.map((l) =>
      l.type === "walk"
        ? `- walk ${l.from.stop_name} → ${l.to.stop_name} (${Math.round(l.duration_secs / 60)} min)`
        : `- ${l.route_short_name || l.route_id} (${l.headsign || l.route_long_name}) ${l.from.stop_name} ${l.from.time} → ${l.to.stop_name} ${l.to.time}, ${l.stops} stops, trip ${l.trip_id}`,
    );
    return {
      content: [
        `Itinerary ${journey.from.stop_name} → ${journey.to.stop_name} on ${journey.date}: depart ${it.departure}, arrive ${it.arrival}, ${Math.round(it.duration_secs / 60)} min, ${it.transfers} transfer(s), first departure ${Math.round(it.wait_before_secs / 60)} min after ${journey.time}.`,
        ...legs,
        journey.diagnostics.length ? `Notes: ${journey.diagnostics.join(", ")} (tight_connection:<stop>:<seconds> means the change time barely fits).` : "",
        "The itinerary card is shown to the user; summarise it and point out anything odd (long waits, detours, tight connections).",
      ].filter(Boolean).join("\n"),
    };
  },
};

// ── remember / forget ─────────────────────────────────────────────────────
const remember = {
  definition: {
    name: "remember",
    description:
      "Store a short fact or decision about THIS feed for the rest of the session ('route 12 is a school service, keep its calendar', 'stop codes are the SAE ids', 'the user wants names in Title Case'), or mute a Diagnostic finding code the user does not care about. Call it when the user states a rule, a preference or a decision you should not ask about again — say what you remembered.",
    input_schema: {
      type: "object",
      properties: {
        note: { type: "string", description: "One sentence, in the user's language (≤ 240 chars)." },
        ignore_finding: { type: "string", description: "A Diagnostic finding code to mute (e.g. duplicate_stops)." },
      },
    },
  },
  run(input, ctx) {
    const note = typeof input?.note === "string" ? input.note.trim() : "";
    const code = typeof input?.ignore_finding === "string" ? input.ignore_finding.trim() : "";
    if (!note && !code) return { content: "Error: give a note and/or an ignore_finding code.", isError: true };
    if (code && !RULE_CODE_RE.test(code)) return { content: "Error: invalid finding code.", isError: true };
    const mem = assistantMemoryService.update(ctx.dbCtx.sessionId, { addNotes: note ? [note] : [], ignore: code ? [code] : [] }, "assistant");
    ctx.emit("memory", { notes: mem.notes.length, ignoredFindings: mem.ignoredFindings });
    return { content: `Remembered. Memory now holds ${mem.notes.length} note(s)${mem.ignoredFindings.length ? ` and ignores: ${mem.ignoredFindings.join(", ")}` : ""}.` };
  },
};

const forget = {
  definition: {
    name: "forget",
    description: "Remove a remembered note (by its text, matched loosely) or un-mute a Diagnostic finding code, when the user changes their mind. `everything: true` clears the session memory.",
    input_schema: {
      type: "object",
      properties: {
        note: { type: "string" },
        unignore_finding: { type: "string" },
        everything: { type: "boolean" },
      },
    },
  },
  run(input, ctx) {
    const sessionId = ctx.dbCtx.sessionId;
    if (input?.everything === true) {
      assistantMemoryService.update(sessionId, { clear: true }, "assistant");
      ctx.emit("memory", { notes: 0, ignoredFindings: [] });
      return { content: "Memory cleared." };
    }
    const note = typeof input?.note === "string" ? input.note.trim().toLowerCase() : "";
    const code = typeof input?.unignore_finding === "string" ? input.unignore_finding.trim() : "";
    const current = assistantMemoryService.load(sessionId);
    const ids = note ? current.notes.filter((n) => n.text.toLowerCase().includes(note) || note.includes(n.text.toLowerCase())).map((n) => n.id) : [];
    if (!ids.length && !code) return { content: "Nothing matched: no such note or code in memory.", isError: true };
    const mem = assistantMemoryService.update(sessionId, { removeNoteIds: ids, unignore: code ? [code] : [] }, "assistant");
    ctx.emit("memory", { notes: mem.notes.length, ignoredFindings: mem.ignoredFindings });
    return { content: `Forgotten (${ids.length} note(s) removed${code ? `, ${code} no longer ignored` : ""}).` };
  },
};


// ── suggest_change ────────────────────────────────────────────────────────
const suggestChange = {
  definition: {
    name: "suggest_change",
    description:
      "The user asks to CHANGE the feed (add, remove, move, rename, retime, extend, fix…). You never change it yourself. Read what you need first, then call this once with the request written as a clear brief in the user's language: what to change, on which lines, stops, days and dates, from when, and what must stay as it is, with the names and figures you read in the feed. The card offers to prepare the change from this brief in a draft (an agent makes it on a copy, an independent review checks every demand, the user decides). Add `sql` only when one UPDATE, INSERT or DELETE statement says the change exactly: an expert may open it in the SQL console, it is never run from here.",
    input_schema: {
      type: "object",
      properties: {
        brief: { type: "string", description: "The change written as a brief, in the user's language (at most 2000 characters)." },
        sql: { type: "string", description: "Optional: one statement that makes exactly this change." },
      },
      required: ["brief"],
    },
  },
  run(input, ctx) {
    const brief = clip(String(input?.brief || "").trim(), 2000);
    if (brief.length < 3) return { content: "Error: brief is required.", isError: true };
    const sql = typeof input?.sql === "string" && input.sql.trim() ? clip(input.sql.trim(), MAX_SQL_CHARS) : null;
    ctx.emit("change", { changeId: ctx.nextChangeId(), brief, ...(sql ? { sql } : {}) });
    return { content: "The card is shown: the user prepares the change from this brief when they choose. Say in one sentence what the change will involve; never describe it as done." };
  },
};

const TOOLS = [runSql, getValidationFindings, getRuleInfo, getFeedOverview, navigate, showChart, runQualityAudit, getStopNameVariants, planJourney, suggestChange, remember, forget];
const TOOL_DEFINITIONS = TOOLS.map((t) => t.definition);
const TOOLS_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.definition.name, t]));

// Every tool reads: the reading companion (an account without the licence) gets the same ones as the licensed account.
const READ_ONLY_TOOLS = Object.freeze(TOOL_DEFINITIONS.map((d) => d.name));

/** The definitions sent to the model for a turn: every tool, or only the named ones (unknown names ignored). */
const toolDefinitionsFor = (names = null) => {
  return Array.isArray(names) ? TOOL_DEFINITIONS.filter((d) => names.includes(d.name)) : TOOL_DEFINITIONS;
};

// `allowedTools`: the names offered this turn (null: every tool).
const createToolContext = ({ dbCtx, emit, allowedTools = null }) => {
  let stepSeq = 0;
  let changeSeq = 0;
  let actionSeq = 0;
  let chartSeq = 0;
  let journeySeq = 0;
  return {
    dbCtx,
    emit,
    allowedTools: Array.isArray(allowedTools) ? new Set(allowedTools) : null,
    steps: new Map(),
    nextStepId: () => `s${++stepSeq}`,
    nextChangeId: () => `ch${++changeSeq}`,
    nextActionId: () => `a${++actionSeq}`,
    nextChartId: () => `c${++chartSeq}`,
    nextJourneyId: () => `j${++journeySeq}`,
  };
};

// An asynchronous tool's rejection is a tool error too. A tool outside the turn's set is refused whatever the model
// asks: the set sent to the model is not the only bound.
const executeTool = (name, input, ctx) => {
  const tool = TOOLS_BY_NAME[name];
  if (!tool) return { content: `Error: unknown tool ${name}.`, isError: true };
  if (ctx && ctx.allowedTools && !ctx.allowedTools.has(name)) return { content: `Error: the tool ${name} is not available in this conversation.`, isError: true };
  try {
    const out = tool.run(input || {}, ctx);
    return out && typeof out.then === "function" ? out.catch((err) => ({ content: `Tool ${name} failed: ${err.message}`, isError: true })) : out;
  } catch (err) {
    return { content: `Tool ${name} failed: ${err.message}`, isError: true };
  }
};

module.exports = {
  TOOL_DEFINITIONS,
  READ_ONLY_TOOLS,
  toolDefinitionsFor,
  createToolContext,
  executeTool,
  _internals: { summarizeStoredReport, resultSnapshot, TOOLS_BY_NAME },
};
