/** A draft's changes as the decisions list them: grouped by line in the diff's order, the rest (no line) apart. */

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
