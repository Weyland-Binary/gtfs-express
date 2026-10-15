// The console's building blocks: one look for every screen — a page header, quiet panels, figures with their
// change, tables that sort, filter, page and export, status pills, confirmations. Colours come from the theme
// only (rule #19), light and dark alike.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  InputAdornment,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  TextField,
  Tooltip,
  Typography,
  alpha,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import SearchIcon from "@mui/icons-material/Search";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import ArrowUpwardRoundedIcon from "@mui/icons-material/ArrowUpwardRounded";
import ArrowDownwardRoundedIcon from "@mui/icons-material/ArrowDownwardRounded";
import InboxOutlinedIcon from "@mui/icons-material/InboxOutlined";
import { fmtPct } from "./format";

export const TABULAR = { fontVariantNumeric: "tabular-nums" };

// ── Data ───────────────────────────────────────────────────────────────────

/**
 * Load a screen's data: { data, error, loading, reload, updatedAt }. The last data stays on screen while it reloads
 * and when a reload fails (the error is shown beside it). With `refreshMs`, it reloads on its own while the tab is
 * visible; `deps` reload it at once.
 */
export function useAdminQuery(fetcher, deps = [], { refreshMs = 0, enabled = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: Boolean(enabled), updatedAt: null });
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fetchRef.current();
      if (n === seq.current) setState({ data, error: null, loading: false, updatedAt: new Date() });
    } catch (error) {
      if (n === seq.current) setState((s) => ({ ...s, error, loading: false }));
    }
  }, []);
  useEffect(() => {
    if (enabled) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, reload, ...deps]);
  useEffect(() => {
    if (!refreshMs || !enabled) return undefined;
    const tick = () => {
      if (typeof document === "undefined" || !document.hidden) reload();
    };
    const id = setInterval(tick, refreshMs);
    return () => clearInterval(id);
  }, [refreshMs, enabled, reload]);
  return { ...state, reload };
}

// ── Layout ─────────────────────────────────────────────────────────────────

export function PageHeader({ title, description, actions, children }) {
  return (
    <Box sx={{ mb: 3 }}>
      <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ xs: "stretch", sm: "flex-start" }} justifyContent="space-between" gap={{ xs: 1.5, sm: 2 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography component="h1" sx={{ fontSize: { xs: 21, md: 24 }, fontWeight: 650, letterSpacing: "-0.01em", lineHeight: 1.25 }}>
            {title}
          </Typography>
          {description ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 760 }}>
              {description}
            </Typography>
          ) : null}
        </Box>
        {actions ? (
          <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexShrink: 0, flexWrap: "wrap", rowGap: 1 }}>
            {actions}
          </Stack>
        ) : null}
      </Stack>
      {children}
    </Box>
  );
}

/** A quiet card: a title line (with its actions), then its content. */
export function Panel({ title, subtitle, actions, children, padded = true, sx, testId }) {
  return (
    <Paper variant="outlined" data-testid={testId} sx={{ borderRadius: "14px", overflow: "hidden", display: "flex", flexDirection: "column", minWidth: 0, ...sx }}>
      {title || actions ? (
        <Stack direction="row" alignItems="center" justifyContent="space-between" useFlexGap sx={{ px: { xs: 2, md: 2.5 }, pt: 2, pb: padded ? 1 : 1.5, minHeight: 52, flexWrap: "wrap", columnGap: 2, rowGap: 1 }}>
          <Box sx={{ minWidth: 0 }}>
            {title ? (
              <Typography component="h2" sx={{ fontSize: 15, fontWeight: 600 }}>
                {title}
              </Typography>
            ) : null}
            {subtitle ? (
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.25 }}>
                {subtitle}
              </Typography>
            ) : null}
          </Box>
          {actions ? (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexShrink: 0 }}>
              {actions}
            </Stack>
          ) : null}
        </Stack>
      ) : null}
      <Box sx={{ px: padded ? { xs: 2, md: 2.5 } : 0, pb: padded ? { xs: 2, md: 2.5 } : 0, flex: 1, minHeight: 0, minWidth: 0 }}>{children}</Box>
    </Paper>
  );
}

// On a phone (under sm) the cells shrink to PHONE_MIN, two a row, whatever `min` a screen asks on a wider one.
const PHONE_MIN = 148;
export function Grid({ min = 220, gap = 2, children, sx }) {
  const cols = (m) => `repeat(auto-fill, minmax(min(${m}px, 100%), 1fr))`;
  return <Box sx={{ display: "grid", gap: { xs: 1.25, sm: gap }, gridTemplateColumns: { xs: cols(Math.min(min, PHONE_MIN)), sm: cols(min) }, ...sx }}>{children}</Box>;
}

// ── Figures ────────────────────────────────────────────────────────────────

/** The change of a figure against the period before: green when it moves the good way (`invert`: less is good). */
export function Delta({ value, invert = false, suffix = "vs previous" }) {
  const theme = useTheme();
  if (value == null || !Number.isFinite(value)) return null;
  const up = value > 0;
  const flat = Math.abs(value) < 0.005;
  const good = flat ? null : up !== invert;
  const color = good == null ? theme.palette.text.secondary : good ? theme.palette.success.main : theme.palette.error.main;
  const Icon = up ? ArrowUpwardRoundedIcon : ArrowDownwardRoundedIcon;
  return (
    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ color, ...TABULAR }}>
      {flat ? null : <Icon sx={{ fontSize: 14 }} />}
      <Typography variant="caption" sx={{ fontWeight: 600, color: "inherit" }}>
        {flat ? "±0%" : fmtPct(Math.abs(value), Math.abs(value) < 0.1 ? 1 : 0)}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {suffix}
      </Typography>
    </Stack>
  );
}

export function Sparkline({ data, dataKey, color, height = 36 }) {
  const id = useMemo(() => `spark-${Math.random().toString(36).slice(2)}`, []);
  if (!data || data.length < 2) return <Box sx={{ height }} />;
  return (
    <Box sx={{ height, mx: -0.5 }} aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.6} fill={`url(#${id})`} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </Box>
  );
}

/** A key figure: its label, its value, its change and its trend. */
export function Kpi({ label, value, sub, delta, invert, spark, sparkKey, color, onClick, loading, testId, icon }) {
  const theme = useTheme();
  const tone = color || theme.palette.primary.main;
  return (
    <Paper
      variant="outlined"
      data-testid={testId}
      onClick={onClick}
      sx={{
        borderRadius: "14px",
        px: { xs: 1.75, sm: 2.25 },
        pt: { xs: 1.5, sm: 2 },
        pb: spark ? 1 : 2,
        cursor: onClick ? "pointer" : "default",
        transition: "border-color 120ms, box-shadow 120ms",
        "&:hover": onClick ? { borderColor: alpha(tone, 0.5), boxShadow: `0 1px 0 ${alpha(tone, 0.15)}` } : undefined,
        minWidth: 0,
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ color: "text.secondary", mb: 1 }}>
        {icon ? (
          <Box component="span" sx={{ width: 24, height: 24, borderRadius: "7px", display: "grid", placeItems: "center", flexShrink: 0, bgcolor: alpha(tone, theme.palette.mode === "dark" ? 0.18 : 0.1) }}>
            {React.cloneElement(icon, { sx: { fontSize: 15, color: tone } })}
          </Box>
        ) : null}
        <Typography variant="caption" noWrap sx={{ fontWeight: 600, letterSpacing: "0.02em", color: "text.secondary", minWidth: 0 }}>
          {label}
        </Typography>
      </Stack>
      {loading ? (
        <Skeleton width="60%" height={36} />
      ) : (
        <Typography sx={{ fontSize: { xs: 22, sm: 28 }, fontWeight: 650, lineHeight: 1.15, letterSpacing: "-0.02em", ...TABULAR }}>{value}</Typography>
      )}
      <Box sx={{ minHeight: 20, mt: 0.5 }}>
        {delta !== undefined ? <Delta value={delta} invert={invert} /> : null}
        {sub ? (
          <Typography variant="caption" color="text.secondary" component="div" sx={{ ...TABULAR, mt: delta !== undefined ? 0.25 : 0 }}>
            {sub}
          </Typography>
        ) : null}
      </Box>
      {spark ? <Sparkline data={spark} dataKey={sparkKey} color={tone} /> : null}
    </Paper>
  );
}

/** A label and its value, stacked: the facts of a detail panel. */
export function Fact({ label, children, mono }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", fontWeight: 500 }}>
        {label}
      </Typography>
      <Typography variant="body2" component="div" sx={{ mt: 0.25, overflowWrap: "anywhere", ...(mono ? { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5 } : {}), ...TABULAR }}>
        {children ?? "—"}
      </Typography>
    </Box>
  );
}

// ── Status ─────────────────────────────────────────────────────────────────

const toneColor = (theme, tone) => {
  switch (tone) {
    case "success":
      return theme.palette.success.main;
    case "warning":
      return theme.palette.warning.main;
    case "error":
      return theme.palette.error.main;
    case "info":
      return theme.palette.info.main;
    case "ai":
      return theme.palette.ai.main;
    case "primary":
      return theme.palette.primary.main;
    default:
      return theme.palette.text.secondary;
  }
};
export const useTone = () => {
  const theme = useTheme();
  return (tone) => toneColor(theme, tone);
};

/** A small state label: a dot and a word, tinted by its tone. */
export function StatusPill({ tone = "neutral", label, title, testId }) {
  const theme = useTheme();
  const c = toneColor(theme, tone);
  const pill = (
    <Box
      component="span"
      data-testid={testId}
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.75,
        px: 1,
        py: 0.25,
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.6,
        whiteSpace: "nowrap",
        color: c,
        bgcolor: alpha(c, theme.palette.mode === "dark" ? 0.16 : 0.09),
      }}
    >
      <Box component="span" sx={{ width: 6, height: 6, borderRadius: "50%", bgcolor: c, flexShrink: 0 }} />
      {label}
    </Box>
  );
  return title ? <Tooltip title={title}>{pill}</Tooltip> : pill;
}

export function EmptyState({ title = "Nothing here yet", text, icon, dense }) {
  return (
    <Stack alignItems="center" justifyContent="center" spacing={1} sx={{ py: dense ? 3 : 6, color: "text.secondary", textAlign: "center" }}>
      {icon || <InboxOutlinedIcon sx={{ fontSize: 28, opacity: 0.6 }} />}
      <Typography variant="body2" sx={{ fontWeight: 600, color: "text.primary" }}>
        {title}
      </Typography>
      {text ? (
        <Typography variant="caption" sx={{ maxWidth: 420 }}>
          {text}
        </Typography>
      ) : null}
    </Stack>
  );
}

/** A failed load said plainly, with a retry; the data already shown stays. */
export function ErrorNotice({ error, onRetry, sx }) {
  if (!error) return null;
  const text =
    error.code === "ACCOUNTS_DISABLED"
      ? "Accounts are off on this server: this screen has nothing to read."
      : error.status === 0
        ? "The API cannot be reached."
        : error.message || "Something went wrong.";
  return (
    <Alert
      severity={error.code === "ACCOUNTS_DISABLED" ? "info" : "error"}
      variant="outlined"
      sx={{ borderRadius: "8px", mb: 2, ...sx }}
      action={
        onRetry && error.code !== "ACCOUNTS_DISABLED" ? (
          <Button color="inherit" size="small" onClick={onRetry}>
            Retry
          </Button>
        ) : null
      }
    >
      {text}
    </Alert>
  );
}

// ── Tables ─────────────────────────────────────────────────────────────────

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Download rows as a CSV file (the columns' `csv` value, else their raw `value`). */
export function downloadCsv(name, columns, rows) {
  const cols = columns.filter((c) => c.csv !== false);
  const lines = [cols.map((c) => csvCell(c.label)).join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(typeof c.csv === "function" ? c.csv(r) : c.value ? c.value(r) : r[c.key])).join(","));
  // A byte-order mark first: a spreadsheet then reads the accents as UTF-8.
  const bom = String.fromCharCode(0xfeff);
  const blob = new Blob([bom, lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * A dense table that sorts (a click on a header), filters (the search box: `searchText(row)`), pages and exports.
 * columns: [{ key, label, align, width, render(row), value(row) — what sorts and exports, csv }].
 */
export function DataTable({
  columns,
  rows,
  getRowId = (r) => r.id,
  onRowClick,
  selectedId,
  searchText,
  searchPlaceholder = "Search",
  toolbar,
  initialSort,
  pageSize = 25,
  emptyTitle = "Nothing to show",
  emptyText,
  csvName,
  loading,
  maxHeight,
  testId,
  dense = true,
  initialQuery = "",
}) {
  const theme = useTheme();
  // A column marked `hidden` is exported, never drawn.
  const visible = columns.filter((c) => !c.hidden);
  const [query, setQuery] = useState(initialQuery);
  useEffect(() => setQuery(initialQuery), [initialQuery]);
  const [sort, setSort] = useState(initialSort || null);
  const [page, setPage] = useState(0);
  const [perPage, setPerPage] = useState(pageSize);
  const list = useMemo(() => {
    let out = Array.isArray(rows) ? rows : [];
    const q = query.trim().toLowerCase();
    if (q && searchText) out = out.filter((r) => String(searchText(r) || "").toLowerCase().includes(q));
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      const get = col && col.value ? col.value : (r) => r[sort.key];
      out = [...out].sort((a, b) => {
        const x = get(a);
        const y = get(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
        return sort.dir === "asc" ? c : -c;
      });
    }
    return out;
  }, [rows, query, sort, columns, searchText]);
  useEffect(() => setPage(0), [query, sort, rows]);
  const shown = list.slice(page * perPage, page * perPage + perPage);
  const toggle = (key) => setSort((s) => (s && s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));
  const hasToolbar = searchText || toolbar || csvName;
  return (
    <Box data-testid={testId} sx={{ minWidth: 0 }}>
      {hasToolbar ? (
        <Stack direction="row" alignItems="center" useFlexGap sx={{ px: { xs: 2, md: 2.5 }, pb: 1.5, flexWrap: "wrap", columnGap: 1.5, rowGap: 1 }}>
          {searchText ? (
            <TextField
              size="small"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              inputProps={{ "aria-label": searchPlaceholder, "data-testid": testId ? `${testId}-search` : undefined }}
              InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
              sx={{ width: { xs: "100%", sm: 280 } }}
            />
          ) : null}
          {toolbar}
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary" sx={TABULAR}>
            {list.length === (rows || []).length ? `${list.length} rows` : `${list.length} of ${(rows || []).length}`}
          </Typography>
          {csvName ? (
            <Tooltip title="Download as CSV">
              <span>
                <IconButton size="small" onClick={() => downloadCsv(csvName, columns, list)} disabled={!list.length} aria-label="Download as CSV">
                  <FileDownloadOutlinedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          ) : null}
        </Stack>
      ) : null}
      <TableContainer sx={{ maxHeight, overflowX: "auto", WebkitOverflowScrolling: "touch", borderTop: `1px solid ${theme.palette.divider}` }}>
        <Table size={dense ? "small" : "medium"} stickyHeader>
          <TableHead>
            <TableRow>
              {visible.map((c) => (
                <TableCell
                  key={c.key}
                  align={c.align || "left"}
                  sortDirection={sort && sort.key === c.key ? sort.dir : false}
                  sx={{ width: c.width, whiteSpace: "nowrap", fontSize: 12, fontWeight: 600, color: "text.secondary", bgcolor: "background.paper", py: 1, "&:first-of-type": { pl: 2.5 }, "&:last-of-type": { pr: 2.5 } }}
                >
                  {c.sortable === false ? (
                    c.label
                  ) : (
                    <TableSortLabel active={Boolean(sort && sort.key === c.key)} direction={sort && sort.key === c.key ? sort.dir : "desc"} onClick={() => toggle(c.key)}>
                      {c.label}
                    </TableSortLabel>
                  )}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {loading && !shown.length
              ? [0, 1, 2, 3].map((i) => (
                  <TableRow key={`s${i}`}>
                    {visible.map((c) => (
                      <TableCell key={c.key} sx={{ "&:first-of-type": { pl: 2.5 } }}>
                        <Skeleton width="70%" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : shown.map((r) => {
                  const id = getRowId(r);
                  return (
                    <TableRow
                      key={id}
                      hover={Boolean(onRowClick)}
                      selected={selectedId != null && id === selectedId}
                      onClick={onRowClick ? () => onRowClick(r) : undefined}
                      sx={{ cursor: onRowClick ? "pointer" : "default", "&:last-of-type td": { borderBottom: 0 } }}
                    >
                      {visible.map((c) => (
                        <TableCell key={c.key} align={c.align || "left"} sx={{ fontSize: 13, py: 1, whiteSpace: c.wrap ? "normal" : "nowrap", ...(c.align === "right" ? TABULAR : {}), "&:first-of-type": { pl: 2.5 }, "&:last-of-type": { pr: 2.5 }, ...(c.cellSx || {}) }}>
                          {c.render ? c.render(r) : (c.value ? c.value(r) : r[c.key]) ?? "—"}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
          </TableBody>
        </Table>
      </TableContainer>
      {!loading && !list.length ? <EmptyState dense title={query ? "No row matches" : emptyTitle} text={query ? null : emptyText} /> : null}
      {list.length > perPage ? (
        <TablePagination
          component="div"
          count={list.length}
          page={page}
          onPageChange={(_e, p) => setPage(p)}
          rowsPerPage={perPage}
          onRowsPerPageChange={(e) => {
            setPerPage(parseInt(e.target.value, 10));
            setPage(0);
          }}
          rowsPerPageOptions={[25, 50, 100]}
          sx={{ borderTop: `1px solid ${theme.palette.divider}`, "& .MuiTablePagination-selectLabel, & .MuiTablePagination-input": { display: { xs: "none", sm: "flex" } }, "& .MuiTablePagination-toolbar": { pl: { xs: 2, md: 2.5 } } }}
        />
      ) : null}
    </Box>
  );
}

// ── Confirmation ───────────────────────────────────────────────────────────

/** A confirmation before an act; `typed` asks the operator to type a word first (the acts that cannot be undone). */
export function ConfirmDialog({ open, title, body, confirmLabel = "Confirm", tone = "primary", typed, onConfirm, onClose, busy }) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (open) setText("");
  }, [open]);
  const ready = !typed || text.trim().toLowerCase() === String(typed).toLowerCase();
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 17, fontWeight: 650 }}>{title}</DialogTitle>
      <DialogContent>
        {typeof body === "string" ? <DialogContentText>{body}</DialogContentText> : body}
        {typed ? (
          <TextField
            autoFocus
            fullWidth
            size="small"
            sx={{ mt: 2 }}
            label={`Type « ${typed} » to confirm`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            inputProps={{ "data-testid": "confirm-typed" }}
          />
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" color={tone} onClick={onConfirm} disabled={!ready || busy} data-testid="confirm-act" disableElevation>
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** Tabs drawn as a quiet segmented row (a screen's sub-views). */
export function Segments({ value, onChange, items, testId }) {
  const theme = useTheme();
  return (
    <Stack direction="row" role="tablist" data-testid={testId} sx={{ borderBottom: `1px solid ${theme.palette.divider}`, mb: 2.5, gap: { xs: 2, sm: 2.5 }, overflowX: "auto", scrollbarWidth: "none", "&::-webkit-scrollbar": { display: "none" } }}>
      {items.map((it) => {
        const active = it.value === value;
        return (
          <Box
            key={it.value}
            role="tab"
            tabIndex={0}
            aria-selected={active}
            data-testid={testId ? `${testId}-${it.value}` : undefined}
            onClick={() => onChange(it.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onChange(it.value);
              }
            }}
            sx={{
              py: 1.25,
              mb: "-1px",
              cursor: "pointer",
              flexShrink: 0,
              whiteSpace: "nowrap",
              fontSize: 14,
              fontWeight: active ? 600 : 500,
              color: active ? "text.primary" : "text.secondary",
              borderBottom: `2px solid ${active ? theme.palette.primary.main : "transparent"}`,
              display: "flex",
              alignItems: "center",
              gap: 0.75,
              "&:hover": { color: "text.primary" },
              outlineOffset: 2,
            }}
          >
            {it.label}
            {it.count ? (
              <Box component="span" sx={{ fontSize: 11, fontWeight: 600, px: 0.75, borderRadius: 999, bgcolor: alpha(theme.palette.primary.main, 0.12), color: "primary.main", ...TABULAR }}>
                {it.count}
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Stack>
  );
}
