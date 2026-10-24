const hex = (v) => (/^#?[0-9a-f]{6}$/i.test(String(v || "").trim()) ? `#${String(v).trim().replace(/^#/, "")}` : null);

/** { bg, fg } for the route (by id or by its short name), or null when the feed gives it no colour. */
export const lineColorsOf = (routes, key, theme) => {
  const k = String(key ?? "");
  const r = (routes || []).find((x) => String(x.id) === k || String(x.route_id) === k) || (routes || []).find((x) => String(x.short_name) === k);
  const bg = hex(r?.color || r?.route_color);
  if (!bg) return null;
  return { bg, fg: hex(r?.text_color || r?.route_text_color) || theme.palette.getContrastText(bg) };
};
