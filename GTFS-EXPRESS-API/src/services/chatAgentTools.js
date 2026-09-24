/**
 * chatAgentTools — the tools the chat assistant can call during a turn.
 *
 * Each tool has an Anthropic tool definition (`definition`) and an executor
 * `run(input, ctx)` returning `{ content, isError? }` — `content` is the text
 * handed back to the model. Executors also emit the SSE events the UI
 * renders (steps, proposals, charts, navigation) through `ctx.emit`.
 *
 * Every executor treats its input as untrusted: identifiers are validated,
 * SQL goes through the SQL Console classifier (read-only for run_sql, and
 * never executed at all for propose_fix — a dry-run only), payload sizes are
 * capped before anything reaches the model or the browser.
 */

"use strict";

const sqlConsoleService = require("./edit/sqlConsoleService");
const validationReportStore = require("./validationReportStore");
const qualityAuditService = require("./qualityAuditService");
const tripEditService = require("./edit/tripEditService");
const smartEditService = require("./edit/smartEditService");
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
const runSql = {
  definition: {
    name: "run_sql",
    description:
      "Run ONE read-only SQLite query (SELECT / WITH … SELECT) against the loaded GTFS feed and get its result (row count, columns, a sample of rows). The user sees the query and a table of the first rows. Mutations are refused: use propose_fix for UPDATE/INSERT/DELETE.",
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
  run(input, ctx) {
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
          ? "Mutations are not executed from the chat — use propose_fix."
          : parsed.error,
      });
      return {
        content: isMutation
          ? "Refused: this statement modifies data. Call propose_fix with it instead (the user will preview and apply it)."
          : `SQL rejected: ${parsed.error}`,
        isError: true,
      };
    }
    ctx.emit("step_start", { stepId, kind: "sql", sql, purpose });
    const t0 = Date.now();
    const exec = sqlConsoleService.executeSqlInSession(ctx.dbCtx, sql, {
      allowMutations: false,
    });
    if (exec.status >= 400) {
      const message = exec.body?.error || "SQL execution failed.";
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

// ── propose_fix ───────────────────────────────────────────────────────────
const proposeFix = {
  definition: {
    name: "propose_fix",
    description:
      "Propose a data fix (one or a few UPDATE/INSERT/DELETE statements) as a guided repair card. The statements are NOT executed: the server dry-runs them (affected rows, cascades) and the user decides to apply them, with undo. Use a precise WHERE clause. Returns the dry-run numbers.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title of the fix (≤ 60 chars), in the user's language." },
        sql: { type: "string", description: "The mutation statement(s), SQLite dialect, each ending with ';'." },
        rationale: {
          type: "string",
          description: "One or two sentences on what the fix changes and why it is safe, in the user's language.",
        },
      },
      required: ["title", "sql"],
    },
  },
  run(input, ctx) {
    const sql = typeof input?.sql === "string" ? input.sql.trim() : "";
    const title = clip(typeof input?.title === "string" ? input.title.trim() : "", 80) || "Fix";
    const rationale = clip(typeof input?.rationale === "string" ? input.rationale.trim() : "", 600);
    if (!sql) return { content: "Error: sql is required.", isError: true };
    if (sql.length > MAX_SQL_CHARS) {
      return { content: `Error: statement is too long (max ${MAX_SQL_CHARS} chars).`, isError: true };
    }
    const parsed = sqlConsoleService.parseStatements(sql, { allowMutations: true });
    if (!parsed.ok) return { content: `Statement rejected: ${parsed.error}`, isError: true };
    if (!parsed.statements.some((s) => s.kind === "mutate")) {
      return {
        content: "Not a mutation: propose_fix expects UPDATE/INSERT/DELETE. Use run_sql for SELECT.",
        isError: true,
      };
    }
    let preview;
    try {
      preview = sqlConsoleService.previewStatements(ctx.dbCtx.db, parsed.statements);
    } catch (err) {
      return { content: `Dry-run failed: ${err.message}. Fix the statement and try again.`, isError: true };
    }
    const proposalId = ctx.nextProposalId();
    ctx.emit("proposal", { proposalId, title, rationale, sql, preview });
    const lines = preview.statements
      .filter((s) => s.table)
      .map(
        (s) =>
          `${s.verb} ${s.table}: ${s.affected} row(s)` +
          (s.cascade && s.cascade.length
            ? ` (cascade: ${s.cascade.map((c) => `${c.count} in ${c.table}`).join(", ")})`
            : ""),
      );
    return {
      content: [
        `proposal_id: ${proposalId}`,
        `Dry-run: ${preview.totalAffected} row(s) affected in total.`,
        ...lines,
        preview.exceedsConfirmedCap
          ? `WARNING: exceeds the ${preview.confirmedCap}-row cap; the user cannot apply this as is — narrow the WHERE clause.`
          : preview.totalAffected === 0
            ? "No row matches: the issue may already be fixed (or the WHERE clause is wrong). Check with run_sql before proposing again."
            : "The user can now preview and apply it from the chat. Do not claim it was applied.",
      ].join("\n"),
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
            : "fix=sql: draft with propose_fix after inspecting; fix=studio: point the user to the Shape Studio (navigate shape_studio); fix=review: explain and let the user decide (show rows with run_sql). ignored_by_user=true: the user muted this finding — do not propose a fix unless asked.",
      }),
    };
  },
};

// ── create_trips ──────────────────────────────────────────────────────────
const TIME_RE = /^\d{1,2}:\d{2}(:\d{2})?$/;
const normTime = (t) => {
  const m = TIME_RE.exec(String(t || "").trim());
  if (!m) return null;
  const [h, mi, se = "00"] = String(t).trim().split(":");
  return `${String(parseInt(h, 10)).padStart(2, "0")}:${mi}:${se}`;
};

const createTrips = {
  definition: {
    name: "create_trips",
    description:
      "Propose new trips copied from a template trip (same route, direction, stops and travel times), each starting at a given departure time — 'add a trip at 07:15', 'one every 20 min from 06:00 to 09:00'. Pick the template with run_sql first (a trip of the right route/direction/service). Nothing is written: the user applies the proposal (one undo step). Give either departures or an interval (from/to/every_minutes).",
    input_schema: {
      type: "object",
      properties: {
        template_trip_id: { type: "string" },
        departures: { type: "array", items: { type: "string" }, description: "Departure times HH:MM or HH:MM:SS (may exceed 24:00)." },
        from: { type: "string", description: "First departure of an interval, HH:MM." },
        to: { type: "string", description: "Last departure (inclusive) of an interval, HH:MM." },
        every_minutes: { type: "integer", description: "Headway of the interval in minutes." },
        service_id: { type: "string", description: "Service of the new trips (default: the template's)." },
        trip_headsign: { type: "string" },
        direction_id: { type: "string" },
        title: { type: "string", description: "Short title for the proposal card, in the user's language." },
      },
      required: ["template_trip_id"],
    },
  },
  run(input, ctx) {
    let departures = Array.isArray(input?.departures) ? input.departures.map(normTime) : [];
    if (departures.length === 0 && input?.from && input?.to && input?.every_minutes) {
      const from = tripEditService.gtfsTimeToSeconds(normTime(input.from));
      const to = tripEditService.gtfsTimeToSeconds(normTime(input.to));
      const step = parseInt(input.every_minutes, 10) * 60;
      if (from == null || to == null || !(step > 0)) return { content: "Error: invalid interval (from/to/every_minutes).", isError: true };
      if (to < from) return { content: "Error: 'to' is before 'from'.", isError: true };
      for (let t = from; t <= to && departures.length <= 200; t += step) departures.push(tripEditService.secondsToGtfsTime(t));
    }
    if (departures.some((d) => !d)) return { content: "Error: departures must be HH:MM or HH:MM:SS times.", isError: true };
    if (departures.length === 0) return { content: "Error: give departures or from/to/every_minutes.", isError: true };
    const params = {
      template_trip_id: input.template_trip_id,
      departures,
      ...(input.service_id ? { service_id: String(input.service_id) } : {}),
      ...(input.trip_headsign ? { trip_headsign: String(input.trip_headsign) } : {}),
      ...(input.direction_id != null && input.direction_id !== "" ? { direction_id: String(input.direction_id) } : {}),
    };
    const plan = tripEditService.planTripsFromTemplate(ctx.dbCtx.db, params);
    if (!plan.ok) return { content: `Cannot plan the trips: ${plan.error}`, isError: true };
    const preview = {
      template_trip_id: plan.template.trip_id,
      route_id: plan.template.route_id,
      service_id: plan.serviceId,
      direction_id: plan.directionId,
      trip_headsign: plan.headsign,
      stop_times_per_trip: plan.stopTimesPerTrip,
      trips: plan.trips.map((t) => ({ trip_id: t.trip_id, first_departure: t.first_departure, last_arrival: t.last_arrival })),
    };
    const proposalId = ctx.nextProposalId();
    const title = clip(typeof input?.title === "string" ? input.title.trim() : "", 80) || `Create ${plan.trips.length} trip(s) on route ${plan.template.route_id}`;
    ctx.emit("proposal", {
      proposalId,
      kind: "operation",
      operation: "create_trips",
      title,
      rationale: "",
      params,
      preview,
    });
    return {
      content: [
        `proposal_id: ${proposalId}`,
        `${plan.trips.length} trip(s) planned on route ${plan.template.route_id} (service ${plan.serviceId}, direction ${plan.directionId ?? "—"}), ${plan.stopTimesPerTrip} stops each:`,
        ...plan.trips.slice(0, 12).map((t) => `- ${t.trip_id}: ${t.first_departure} → ${t.last_arrival}`),
        plan.trips.length > 12 ? `… and ${plan.trips.length - 12} more` : "",
        "The user can apply this from the chat. Do not claim the trips exist yet.",
      ].filter(Boolean).join("\n"),
    };
  },
};

// ── shift_trips ───────────────────────────────────────────────────────────
const MAX_SHIFT = 500;
const shiftTrips = {
  definition: {
    name: "shift_trips",
    description:
      "Propose shifting the times of trips by an offset ('delay the 07:15 by 5 minutes', 'move all Saturday trips of route 12 one hour later'). Select trips by ids or by route (+ optional direction / service). Optional from_stop_sequence shifts only the stops from that sequence on. Nothing is written: the user applies the proposal (one undo step).",
    input_schema: {
      type: "object",
      properties: {
        trip_ids: { type: "array", items: { type: "string" } },
        route_id: { type: "string" },
        direction_id: { type: "string" },
        service_id: { type: "string" },
        offset_minutes: { type: "number", description: "Positive = later, negative = earlier." },
        from_stop_sequence: { type: "integer" },
        title: { type: "string" },
      },
      required: ["offset_minutes"],
    },
  },
  run(input, ctx) {
    const db = ctx.dbCtx.db;
    const offset = Math.round(Number(input?.offset_minutes) * 60);
    if (!Number.isFinite(offset) || offset === 0) return { content: "Error: offset_minutes must be a non-zero number.", isError: true };
    let tripIds = Array.isArray(input?.trip_ids) ? input.trip_ids.filter((t) => typeof t === "string" && t.trim()) : [];
    if (tripIds.length === 0 && input?.route_id) {
      const where = ["route_id = ?"];
      const args = [String(input.route_id)];
      if (input.direction_id != null && input.direction_id !== "") {
        where.push("direction_id = ?");
        args.push(String(input.direction_id));
      }
      if (input.service_id) {
        where.push("service_id = ?");
        args.push(String(input.service_id));
      }
      tripIds = db.prepare(`SELECT trip_id FROM trips WHERE ${where.join(" AND ")} ORDER BY trip_id LIMIT ${MAX_SHIFT + 1}`).all(...args).map((r) => r.trip_id);
    }
    if (tripIds.length === 0) return { content: "No trip matches the selection.", isError: true };
    if (tripIds.length > MAX_SHIFT) return { content: `Too many trips (${tripIds.length}); the limit is ${MAX_SHIFT} per operation — narrow the selection.`, isError: true };
    const exists = db.prepare("SELECT 1 FROM trips WHERE trip_id = ?");
    const missing = tripIds.filter((t) => !exists.get(t));
    if (missing.length) return { content: `Unknown trip id(s): ${missing.slice(0, 5).join(", ")}`, isError: true };
    const fromSeq = Number.isInteger(input?.from_stop_sequence) ? input.from_stop_sequence : null;
    const ph = tripIds.map(() => "?").join(",");
    const stCount = db
      .prepare(`SELECT COUNT(*) AS n FROM stop_times WHERE trip_id IN (${ph})${fromSeq != null ? " AND CAST(stop_sequence AS INTEGER) >= ?" : ""}`)
      .get(...tripIds, ...(fromSeq != null ? [fromSeq] : [])).n;
    const span = db
      .prepare(`SELECT MIN(departure_time) AS first, MAX(arrival_time) AS last FROM stop_times WHERE trip_id IN (${ph})`)
      .get(...tripIds);
    const params = { trip_ids: tripIds, offset_secs: offset, ...(fromSeq != null ? { from_stop_sequence: fromSeq } : {}) };
    const preview = { trips: tripIds.length, stop_times: stCount, first_departure: span.first, last_arrival: span.last, offset_secs: offset };
    const proposalId = ctx.nextProposalId();
    const minutes = offset / 60;
    const title = clip(typeof input?.title === "string" ? input.title.trim() : "", 80) || `Shift ${tripIds.length} trip(s) by ${minutes > 0 ? "+" : ""}${minutes} min`;
    ctx.emit("proposal", { proposalId, kind: "operation", operation: "shift_trips", title, rationale: "", params, preview });
    return {
      content: `proposal_id: ${proposalId}\n${tripIds.length} trip(s), ${stCount} stop_times would move by ${minutes > 0 ? "+" : ""}${minutes} min (current span ${span.first} → ${span.last}). The user can apply this from the chat.`,
    };
  },
};

// ── insert_stop ───────────────────────────────────────────────────────────
const insertStop = {
  definition: {
    name: "insert_stop",
    description:
      "Propose adding an existing stop to every trip of a route/direction (or given trip ids) between two stops it already serves: 'add stop X after Y on line 12 northbound'. The server interpolates arrival/departure times from the real distances between the stops, skips trips already serving X, and flags shapes that would need a re-fit in the Shape Studio. Nothing is written until the user applies it (one undo step). Find the stop ids with run_sql first.",
    input_schema: {
      type: "object",
      properties: {
        stop_id: { type: "string", description: "The stop to insert (must exist in stops)." },
        after_stop_id: { type: "string", description: "Insert right after this stop of the trip." },
        before_stop_id: { type: "string", description: "Insert right before this stop (give both when the stop goes between two known stops)." },
        route_id: { type: "string" },
        direction_id: { type: "string" },
        service_id: { type: "string" },
        trip_ids: { type: "array", items: { type: "string" }, description: "Explicit trips instead of route/direction." },
        title: { type: "string", description: "Short title for the proposal card, in the user's language." },
      },
      required: ["stop_id"],
    },
  },
  run(input, ctx) {
    const params = {};
    for (const k of ["stop_id", "after_stop_id", "before_stop_id", "route_id", "direction_id", "service_id"]) {
      if (input?.[k] != null && String(input[k]).trim() !== "") params[k] = String(input[k]).trim();
    }
    if (Array.isArray(input?.trip_ids) && input.trip_ids.length) params.trip_ids = input.trip_ids.map(String);
    const plan = smartEditService.planStopInsertion(ctx.dbCtx.db, params);
    if (!plan.ok) {
      const sk = plan.skipped ? ` (skipped: ${JSON.stringify(plan.skipped)})` : "";
      return { content: `Cannot plan the insertion: ${plan.error}${sk}`, isError: true };
    }
    const preview = {
      stop: plan.stop,
      route_id: plan.route_id,
      direction_id: plan.direction_id,
      after_stop_id: plan.after_stop_id,
      before_stop_id: plan.before_stop_id,
      trips: plan.trips.slice(0, 200).map((t) => ({ trip_id: t.trip_id, stop_sequence: t.stop_sequence, arrival_time: t.arrival_time, after: t.after, before: t.before })),
      trip_count: plan.trips.length,
      skipped: plan.skipped,
      shapes_to_review: plan.shapes_to_review,
    };
    const proposalId = ctx.nextProposalId();
    const title = clip(typeof input?.title === "string" ? input.title.trim() : "", 80) || `Add stop ${plan.stop.stop_name || plan.stop.stop_id} to ${plan.trips.length} trip(s)`;
    ctx.emit("proposal", { proposalId, kind: "operation", operation: "insert_stop", title, rationale: "", params, preview });
    const sample = plan.trips.slice(0, 6).map((t) => `- ${t.trip_id}: seq ${t.stop_sequence}, ${t.arrival_time || "no time"} (after ${t.after || "—"}, before ${t.before || "—"})`);
    return {
      content: [
        `proposal_id: ${proposalId}`,
        `${plan.trips.length} trip(s) of route ${plan.route_id} would get stop ${plan.stop.stop_id} (${plan.stop.stop_name || ""}); skipped: ${plan.skipped.already_present} already serve it, ${plan.skipped.no_anchor} do not serve the anchor, ${plan.skipped.not_consecutive} have other stops between the anchors.`,
        ...sample,
        plan.shapes_to_review.length
          ? `${plan.shapes_to_review.length} shape(s) run more than ${plan.shapes_to_review[0].distance_m >= 0 ? "50" : "50"} m from the stop (${plan.shapes_to_review.slice(0, 5).map((s) => `${s.shape_id}: ${s.distance_m} m`).join(", ")}): tell the user to re-fit them in the Shape Studio after applying.`
          : "Shapes are fine (the stop lies on or near them).",
        "The user can apply this from the chat. Do not claim it is done.",
      ].join("\n"),
    };
  },
};

// ── merge_stops ───────────────────────────────────────────────────────────
const mergeStops = {
  definition: {
    name: "merge_stops",
    description:
      "Propose merging duplicate stops into one survivor: every reference (stop_times, transfers, pathways, child stops, stop areas, fare rules) is re-pointed to the survivor, the duplicates are deleted, and the survivor's empty optional fields are filled from them. Use it for the duplicate_stops audit finding or when the user says two stops are the same. Prefer as survivor the stop with the most stop_times or the cleanest name. Nothing is written until the user applies it (one undo step).",
    input_schema: {
      type: "object",
      properties: {
        survivor_id: { type: "string" },
        duplicate_ids: { type: "array", items: { type: "string" }, description: "Stops to fold into the survivor (1–50)." },
        fill_missing: { type: "boolean", description: "Copy the duplicates' optional fields into the survivor's empty ones (default true)." },
        title: { type: "string" },
      },
      required: ["survivor_id", "duplicate_ids"],
    },
  },
  run(input, ctx) {
    const params = {
      survivor_id: String(input?.survivor_id || "").trim(),
      duplicate_ids: Array.isArray(input?.duplicate_ids) ? input.duplicate_ids.map(String) : [],
      ...(input?.fill_missing === false ? { fill_missing: false } : {}),
    };
    const plan = smartEditService.planStopMerge(ctx.dbCtx.db, params);
    if (!plan.ok) return { content: `Cannot plan the merge: ${plan.error}`, isError: true };
    const preview = {
      survivor: { stop_id: plan.survivor.stop_id, stop_name: plan.survivor.stop_name },
      duplicates: plan.duplicates,
      by_table: plan.by_table,
      trips_with_both: plan.trips_with_both,
      filled: plan.filled,
    };
    const proposalId = ctx.nextProposalId();
    const title = clip(typeof input?.title === "string" ? input.title.trim() : "", 80) || `Merge ${plan.duplicates.length} stop(s) into ${plan.survivor.stop_name || plan.survivor.stop_id}`;
    ctx.emit("proposal", { proposalId, kind: "operation", operation: "merge_stops", title, rationale: "", params, preview });
    return {
      content: [
        `proposal_id: ${proposalId}`,
        `Survivor ${plan.survivor.stop_id} (${plan.survivor.stop_name || ""}) absorbs: ${plan.duplicates.map((d) => `${d.stop_id} (${d.stop_name || ""}, ${d.distance_m ?? "?"} m away, ${d.stop_times} stop_times)`).join("; ")}.`,
        `References re-pointed: ${Object.entries(plan.by_table).map(([t, n]) => `${n} ${t}`).join(", ") || "none"}.`,
        plan.trips_with_both > 0 ? `WARNING: ${plan.trips_with_both} trip(s) serve both stops and would call at the survivor twice — mention it.` : "",
        Object.keys(plan.filled).length ? `Survivor fields filled from the duplicates: ${Object.keys(plan.filled).join(", ")}.` : "",
        "The user can apply this from the chat. Do not claim it is done.",
      ].filter(Boolean).join("\n"),
    };
  },
};

// ── get_stop_name_variants ────────────────────────────────────────────────
const VARIANT_GROUPS_MAX = 40;
const getStopNameVariants = {
  definition: {
    name: "get_stop_name_variants",
    description:
      "Groups of stops whose names are the same once case, accents, punctuation and spacing are ignored, with every spelling and the stops using it. Call it before rename_stops to harmonise names: pick the best spelling per group (correct case and accents, no abbreviations or trailing codes) and propose the renames.",
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

// ── rename_stops ──────────────────────────────────────────────────────────
const renameStops = {
  definition: {
    name: "rename_stops",
    description:
      "Propose renaming stops in batch (name harmonisation, fixing ALL-CAPS names, removing codes from names…). The user reviews the list, unticks what they disagree with and applies (one undo step). Give the final stop_name for each stop_id; unchanged names are ignored.",
    input_schema: {
      type: "object",
      properties: {
        renames: {
          type: "array",
          items: { type: "object", properties: { stop_id: { type: "string" }, stop_name: { type: "string" } }, required: ["stop_id", "stop_name"] },
        },
        title: { type: "string" },
        rationale: { type: "string", description: "One sentence on the naming rule applied, in the user's language." },
      },
      required: ["renames"],
    },
  },
  run(input, ctx) {
    const params = { renames: Array.isArray(input?.renames) ? input.renames.map((r) => ({ stop_id: String(r?.stop_id || ""), stop_name: String(r?.stop_name || "") })) : [] };
    const plan = smartEditService.planStopRenames(ctx.dbCtx.db, params);
    if (!plan.ok) return { content: `Cannot plan the renames: ${plan.error}`, isError: true };
    const preview = { renames: plan.renames, unchanged: plan.unchanged };
    const proposalId = ctx.nextProposalId();
    const title = clip(typeof input?.title === "string" ? input.title.trim() : "", 80) || `Rename ${plan.renames.length} stop(s)`;
    const rationale = clip(typeof input?.rationale === "string" ? input.rationale.trim() : "", 300);
    ctx.emit("proposal", { proposalId, kind: "operation", operation: "rename_stops", title, rationale, params: { renames: plan.renames.map((r) => ({ stop_id: r.stop_id, stop_name: r.stop_name })) }, preview });
    return {
      content: [
        `proposal_id: ${proposalId}`,
        `${plan.renames.length} rename(s) planned (${plan.unchanged} already correct):`,
        ...plan.renames.slice(0, 15).map((r) => `- ${r.stop_id}: "${r.old_name}" → "${r.stop_name}"`),
        plan.renames.length > 15 ? `… and ${plan.renames.length - 15} more` : "",
        "The user can review, untick and apply from the chat. Do not claim it is done.",
      ].filter(Boolean).join("\n"),
    };
  },
};

// ── extend_calendar ───────────────────────────────────────────────────────
const DATE_RE = /^\d{8}$/;
const extendCalendar = {
  definition: {
    name: "extend_calendar",
    description:
      "Propose extending the validity of services: sets calendar.end_date (and feed_info.feed_end_date) to a new date for the given services, or for every service ending before it. Use it for expired feeds / feeds ending soon ('extend the feed to the end of the year', 'prolong the winter service by 3 months'). Existing calendar_dates exceptions are kept; the preview counts those falling in the new window. Nothing is written until the user applies it (one undo step).",
    input_schema: {
      type: "object",
      properties: {
        end_date: { type: "string", description: "New end date, YYYYMMDD." },
        service_ids: { type: "array", items: { type: "string" }, description: "Services to extend (default: all services ending before end_date)." },
        update_feed_info: { type: "boolean", description: "Also push feed_info.feed_end_date (default true)." },
        title: { type: "string" },
      },
      required: ["end_date"],
    },
  },
  run(input, ctx) {
    const endDate = String(input?.end_date || "").replace(/-/g, "").trim();
    if (!DATE_RE.test(endDate)) return { content: "Error: end_date must be YYYYMMDD.", isError: true };
    const params = {
      end_date: endDate,
      ...(Array.isArray(input?.service_ids) && input.service_ids.length ? { service_ids: input.service_ids.map(String) } : {}),
      ...(input?.update_feed_info === false ? { update_feed_info: false } : {}),
    };
    const plan = smartEditService.planCalendarExtension(ctx.dbCtx.db, params);
    if (!plan.ok) return { content: `Cannot plan the extension: ${plan.error}`, isError: true };
    const preview = {
      end_date: plan.end_date,
      services: plan.services,
      unchanged: plan.unchanged,
      feed_info: plan.feed_info ? { old_end_date: plan.feed_info.old, end_date: plan.feed_info.new } : null,
    };
    const proposalId = ctx.nextProposalId();
    const title = clip(typeof input?.title === "string" ? input.title.trim() : "", 80) || `Extend ${plan.services.length} service(s) to ${plan.end_date}`;
    ctx.emit("proposal", { proposalId, kind: "operation", operation: "extend_calendar", title, rationale: "", params, preview });
    return {
      content: [
        `proposal_id: ${proposalId}`,
        `${plan.services.length} service(s) extended to ${plan.end_date} (${plan.unchanged} already reach it):`,
        ...plan.services.slice(0, 12).map((s) => `- ${s.service_id}: ${s.old_end_date || "no end"} → ${s.end_date}, ${s.trips} trip(s)${s.exceptions_in_window ? `, ${s.exceptions_in_window} exception date(s) in the new window` : ""}`),
        plan.services.length > 12 ? `… and ${plan.services.length - 12} more` : "",
        plan.feed_info ? `feed_info.feed_end_date ${plan.feed_info.old} → ${plan.feed_info.new}.` : "",
        "Remind the user that public holidays in the new window are not added automatically (calendar_dates). The user can apply this from the chat.",
      ].filter(Boolean).join("\n"),
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
    const { ok, ...journey } = result;
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

const TOOLS = [
  runSql,
  proposeFix,
  getValidationFindings,
  getRuleInfo,
  getFeedOverview,
  navigate,
  showChart,
  runQualityAudit,
  createTrips,
  shiftTrips,
  insertStop,
  mergeStops,
  getStopNameVariants,
  renameStops,
  extendCalendar,
  planJourney,
  remember,
  forget,
];
const TOOL_DEFINITIONS = TOOLS.map((t) => t.definition);
const TOOLS_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.definition.name, t]));

// Per-turn tool context: step/proposal ids and the rows kept for charts.
const createToolContext = ({ dbCtx, emit }) => {
  let stepSeq = 0;
  let proposalSeq = 0;
  let actionSeq = 0;
  let chartSeq = 0;
  let journeySeq = 0;
  return {
    dbCtx,
    emit,
    steps: new Map(),
    nextStepId: () => `s${++stepSeq}`,
    nextProposalId: () => `p${++proposalSeq}`,
    nextActionId: () => `a${++actionSeq}`,
    nextChartId: () => `c${++chartSeq}`,
    nextJourneyId: () => `j${++journeySeq}`,
  };
};

const executeTool = (name, input, ctx) => {
  const tool = TOOLS_BY_NAME[name];
  if (!tool) return { content: `Error: unknown tool ${name}.`, isError: true };
  try {
    return tool.run(input || {}, ctx);
  } catch (err) {
    return { content: `Tool ${name} failed: ${err.message}`, isError: true };
  }
};

module.exports = {
  TOOL_DEFINITIONS,
  createToolContext,
  executeTool,
  _internals: { summarizeStoredReport, resultSnapshot, TOOLS_BY_NAME },
};
