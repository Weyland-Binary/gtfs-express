/**
 * issueText — the design's validation issues (services/network/networkSpec:
 * { level, code, path, message, …params }) in the reader's words.
 *
 * The server writes its messages in English; the issues a person designing
 * by hand meets first have a sentence here, from the issue's code and the
 * parameters the server gives with it (the line, the stop, the field). Any
 * other one stays the server's own words. The stops no line serves are said
 * once for all (importing a territory's stops would otherwise give one line
 * of « Stop "…" is not served by any line. » per stop).
 *
 *   issueText(issue, t)   → the sentence
 *   groupIssues(list, t)  → [{ ...issue, text }], the unserved stops as one item
 */

const SIMPLE = { no_lines: "network.issue.noLines", line_missing_name: "network.issue.lineName", stop_missing_name: "network.issue.stopName" };

export const issueText = (issue, t) => {
  const i = issue || {};
  if (SIMPLE[i.code]) return t(SIMPLE[i.code]);
  if (i.code === "agency_missing_field" && ["name", "url", "timezone"].includes(i.field)) return t("network.issue.agencyField", { field: t(`network.issue.agencyField.${i.field}`) });
  if (i.code === "direction_too_short" && i.line) return t("network.issue.directionShort", { line: i.line });
  if (i.code === "no_service" && i.line) return t("network.issue.noService", { line: i.line });
  if (i.code === "line_no_directions" && i.line) return t("network.issue.noDirection", { line: i.line });
  if (i.code === "stop_needs_coordinates" && i.stopName) return t("network.issue.stopPosition", { name: i.stopName });
  if (i.code === "stop_unused" && i.stopName) return t("network.issue.stopUnused", { name: i.stopName });
  return i.message || i.code || "";
};

const MAX_NAMES = 5;

export const groupIssues = (list, t) => {
  const all = Array.isArray(list) ? list : [];
  const unused = all.filter((i) => i && i.code === "stop_unused");
  const rest = all.filter((i) => i && i.code !== "stop_unused").map((i) => ({ ...i, text: issueText(i, t) }));
  if (unused.length < 2) return [...rest, ...unused.map((i) => ({ ...i, text: issueText(i, t) }))];
  const names = [...new Set(unused.map((i) => i.stopName).filter(Boolean))];
  const shown = names.slice(0, MAX_NAMES).join(", ") + (names.length > MAX_NAMES ? "…" : "");
  return [...rest, { level: "warning", code: "stop_unused", path: null, grouped: unused.length, text: t("network.issue.stopsUnused", { count: unused.length, names: shown }) }];
};
