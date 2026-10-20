/**
 * changeLines — a draft's changes as the decision lists them: grouped by line, in the diff's order, the rest (stops,
 * calendars, validity: no line) apart. Read by the decision by hand (DecisionScreen's lines) and the brief's report
 * (DirectChange: each line opens in the reader, on a date the change shows on).
 */

/** The draft's changes grouped by line ({ route, label, date, items }) and the rest (no line), in the diff's order. */
export const reviewOf = (preview) => {
  const lines = new Map();
  const network = [];
  for (const it of preview?.diff?.items || []) {
    const key = it?.route ? String(it.route) : it?.label ? `label:${it.label}` : null;
    if (!key) {
      network.push(it);
      continue;
    }
    if (!lines.has(key)) lines.set(key, { route: it.route ? String(it.route) : null, label: String(it.label || it.route), date: it.date || null, items: [] });
    const line = lines.get(key);
    if (!line.date && it.date) line.date = it.date;
    line.items.push(it);
  }
  return { lines: [...lines.values()], network };
};
