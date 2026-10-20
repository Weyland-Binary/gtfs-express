// The console's charts: a trend over days (one or several stacked series), a ranked bar list, and the series'
// colours taken from the theme (rule #19).

import React from "react";
import { Box, Stack, Tooltip, Typography, alpha } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { fmtDay } from "./format";
import { TABULAR } from "./ui";

/** The series colours, in order: the theme's own tones. */
export const useSeriesColors = () => {
  const t = useTheme();
  return [t.palette.primary.main, t.palette.ai.main, t.palette.success.main, t.palette.warning.main, t.palette.info.main, t.palette.secondary.main, t.palette.error.main, t.palette.text.secondary];
};

function ChartTooltip({ active, payload, label, format, labelFormat }) {
  const theme = useTheme();
  if (!active || !payload || !payload.length) return null;
  const items = payload.filter((p) => p.value);
  return (
    <Box sx={{ bgcolor: "background.paper", border: `1px solid ${theme.palette.divider}`, borderRadius: "8px", px: 1.5, py: 1, boxShadow: theme.shadows[3], minWidth: 140 }}>
      <Typography variant="caption" sx={{ fontWeight: 600, display: "block", mb: 0.5 }}>
        {labelFormat ? labelFormat(label) : label}
      </Typography>
      {(items.length ? items : payload).map((p) => (
        <Stack key={p.dataKey} direction="row" spacing={1} alignItems="center" justifyContent="space-between">
          <Stack direction="row" spacing={0.75} alignItems="center">
            <Box sx={{ width: 8, height: 8, borderRadius: "2px", bgcolor: p.color }} />
            <Typography variant="caption" color="text.secondary">
              {p.name}
            </Typography>
          </Stack>
          <Typography variant="caption" sx={{ fontWeight: 600, ...TABULAR }}>
            {format ? format(p.value) : p.value}
          </Typography>
        </Stack>
      ))}
    </Box>
  );
}

/**
 * A trend over days. series: [{ key, name, color? }]; `stacked` stacks them (a total split by kind), else they are
 * drawn as lines over a soft fill.
 */
export function DayTrend({ data, series, height = 220, format, stacked = false, testId }) {
  const theme = useTheme();
  const colors = useSeriesColors();
  const axis = { fontSize: 11, fill: theme.palette.text.secondary };
  return (
    <Box sx={{ height }} data-testid={testId}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            {series.map((s, i) => (
              <linearGradient key={s.key} id={`trend-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color || colors[i % colors.length]} stopOpacity={stacked ? 0.55 : 0.22} />
                <stop offset="100%" stopColor={s.color || colors[i % colors.length]} stopOpacity={stacked ? 0.25 : 0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} stroke={theme.palette.divider} />
          <XAxis dataKey="day" tickFormatter={fmtDay} tick={axis} axisLine={false} tickLine={false} minTickGap={24} />
          <YAxis tick={axis} axisLine={false} tickLine={false} width={48} tickFormatter={format} allowDecimals={false} />
          <RTooltip content={<ChartTooltip format={format} labelFormat={fmtDay} />} cursor={{ stroke: theme.palette.divider }} />
          {series.map((s, i) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stackId={stacked ? "a" : undefined}
              stroke={s.color || colors[i % colors.length]}
              strokeWidth={stacked ? 1.2 : 1.8}
              fill={`url(#trend-${s.key})`}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </Box>
  );
}

/**
 * Bars per day: daily totals, which a smooth curve would invent between the days (costs, calls, errors). `stacked`
 * piles the series (a total split by kind); else they stand side by side (counts of different steps).
 */
export function DayBars({ data, series, height = 180, format, stacked = true, testId }) {
  const theme = useTheme();
  const colors = useSeriesColors();
  const axis = { fontSize: 11, fill: theme.palette.text.secondary };
  return (
    <Box sx={{ height }} data-testid={testId}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={1} barCategoryGap={stacked ? "18%" : "12%"}>
          <CartesianGrid vertical={false} stroke={theme.palette.divider} />
          <XAxis dataKey="day" tickFormatter={fmtDay} tick={axis} axisLine={false} tickLine={false} minTickGap={24} />
          <YAxis tick={axis} axisLine={false} tickLine={false} width={format ? 52 : 40} allowDecimals={false} tickFormatter={format} />
          <RTooltip content={<ChartTooltip format={format} labelFormat={fmtDay} />} cursor={{ fill: alpha(theme.palette.text.primary, 0.04) }} />
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.name} stackId={stacked ? "a" : undefined} fill={s.color || colors[i % colors.length]} radius={!stacked || i === series.length - 1 ? [3, 3, 0, 0] : 0} maxBarSize={stacked ? 28 : 14} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </Box>
  );
}

/**
 * A ranked list with proportional bars: what takes the most, at a glance.
 * items: [{ key, label, value, display?, sub?, color?, onClick? }]
 */
export function BarList({ items, format = (v) => v, max, empty = "Nothing yet", testId }) {
  const theme = useTheme();
  const top = max || Math.max(...items.map((i) => i.value || 0), 0);
  if (!items.length)
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
        {empty}
      </Typography>
    );
  return (
    <Stack spacing={0.75} data-testid={testId}>
      {items.map((it) => {
        const pct = top ? Math.max(2, (100 * (it.value || 0)) / top) : 0;
        const color = it.color || theme.palette.primary.main;
        const row = (
          <Box
            key={it.key}
            onClick={it.onClick}
            sx={{ position: "relative", borderRadius: "6px", overflow: "hidden", cursor: it.onClick ? "pointer" : "default", "&:hover .bar": it.onClick ? { bgcolor: alpha(color, 0.22) } : undefined }}
          >
            <Box className="bar" sx={{ position: "absolute", inset: 0, width: `${pct}%`, bgcolor: alpha(color, theme.palette.mode === "dark" ? 0.22 : 0.12), transition: "background-color 120ms" }} />
            <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2} sx={{ position: "relative", px: 1.25, py: 0.75 }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                  {it.label}
                </Typography>
                {it.sub ? (
                  <Typography variant="caption" color="text.secondary" noWrap component="div">
                    {it.sub}
                  </Typography>
                ) : null}
              </Box>
              <Typography variant="body2" sx={{ fontWeight: 600, flexShrink: 0, ...TABULAR }}>
                {it.display ?? format(it.value)}
              </Typography>
            </Stack>
          </Box>
        );
        return it.tooltip ? (
          <Tooltip key={it.key} title={it.tooltip} placement="top-start">
            {row}
          </Tooltip>
        ) : (
          row
        );
      })}
    </Stack>
  );
}

/** A single bar split into parts (the licences by source, the AI by function), with its legend. */
export function SplitBar({ parts, format = (v) => v, height = 10 }) {
  const colors = useSeriesColors();
  const total = parts.reduce((a, p) => a + (p.value || 0), 0);
  return (
    <Box>
      <Stack direction="row" sx={{ height, borderRadius: 999, overflow: "hidden", bgcolor: "action.hover" }}>
        {total
          ? parts.map((p, i) =>
              p.value ? (
                <Tooltip key={p.key} title={`${p.label}: ${format(p.value)}`}>
                  <Box sx={{ width: `${(100 * p.value) / total}%`, bgcolor: p.color || colors[i % colors.length], "&:not(:last-of-type)": { mr: "2px" } }} />
                </Tooltip>
              ) : null,
            )
          : null}
      </Stack>
      <Stack direction="row" sx={{ mt: 1.25, flexWrap: "wrap", columnGap: 2, rowGap: 0.5 }}>
        {parts.map((p, i) => (
          <Stack key={p.key} direction="row" spacing={0.75} alignItems="center">
            <Box sx={{ width: 8, height: 8, borderRadius: "2px", bgcolor: p.color || colors[i % colors.length] }} />
            <Typography variant="caption" color="text.secondary">
              {p.label}
            </Typography>
            <Typography variant="caption" sx={{ fontWeight: 600, ...TABULAR }}>
              {format(p.value || 0)}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

/** One colour per AI function, the same on every screen. */
export const useFeatureColor = () => {
  const t = useTheme();
  const map = {
    direct: t.palette.ai.main,
    change_planner: t.palette.text.disabled,
    assistant: t.palette.primary.main,
    reader_companion: t.palette.info.main,
    sql_question: t.palette.secondary.main,
    summary: t.palette.success.main,
    field_suggestion: t.palette.warning.main,
    network_studio: t.palette.brand.pink,
    other: t.palette.text.secondary,
    unattributed: t.palette.text.disabled,
  };
  return (feature) => map[feature] || map.other;
};

/**
 * The way to the licence, step by step: each step's people as a bar against the first step's, with the share that
 * reached it from the step before. steps: [{ key, label, value, prev? }]; `onClick` opens the whole screen.
 */
export function FunnelSteps({ steps, format = (v) => v, compact = false, testId }) {
  const theme = useTheme();
  const top = Math.max(...steps.map((s) => s.value || 0), 0);
  return (
    <Stack spacing={compact ? 0.9 : 1.25} data-testid={testId}>
      {steps.map((s, i) => {
        const pct = top ? (100 * (s.value || 0)) / top : 0;
        const before = i > 0 ? steps[i - 1].value || 0 : null;
        const share = before ? (s.value || 0) / before : null;
        const tone = i === 0 ? theme.palette.text.secondary : theme.palette.primary.main;
        return (
          <Box key={s.key} data-testid={testId ? `${testId}-${s.key}` : undefined} sx={{ display: "grid", gridTemplateColumns: compact ? "minmax(0, 1fr) 56px 64px" : "minmax(150px, 220px) minmax(0, 1fr) 64px 92px", alignItems: "center", columnGap: 1.5 }}>
            <Typography variant="body2" noWrap sx={{ fontWeight: 500, gridColumn: compact ? "1 / -1" : "auto", mb: compact ? 0.25 : 0 }}>
              {s.label}
            </Typography>
            <Box sx={{ height: compact ? 8 : 10, borderRadius: 999, bgcolor: "action.hover", overflow: "hidden", minWidth: 0 }}>
              <Box sx={{ height: "100%", width: `${Math.max(pct, s.value ? 1.5 : 0)}%`, borderRadius: 999, bgcolor: alpha(tone, i === 0 ? 0.45 : Math.max(0.35, 1 - i * 0.1)) }} />
            </Box>
            <Typography variant="body2" sx={{ fontWeight: 650, textAlign: "right", ...TABULAR }}>
              {format(s.value || 0)}
            </Typography>
            <Tooltip title={i > 0 ? `${share == null ? "—" : `${Math.round(share * 100)}%`} of « ${steps[i - 1].label} »` : ""}>
              <Typography variant="caption" color="text.secondary" sx={{ textAlign: "right", ...TABULAR }}>
                {i === 0 ? "" : share == null ? "—" : `${share >= 0.995 && share < 1.005 ? "100" : share > 1 ? ">100" : Math.round(share * 100)}%${compact ? "" : " of prev."}`}
              </Typography>
            </Tooltip>
          </Box>
        );
      })}
    </Stack>
  );
}
