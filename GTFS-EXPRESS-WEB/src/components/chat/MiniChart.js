/**
 * MiniChart — a chart the assistant drew from one of its query results
 * (bar / line / pie), rendered with recharts inside the bubble.
 */

import React from "react";
import { Box, Chip, alpha, useTheme } from "@mui/material";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import { useLanguage } from "../../contexts/LanguageContext";

const PALETTE = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#0ea5e9", "#a855f7", "#14b8a6", "#f97316"];

export default function MiniChart({ chart }) {
  const theme = useTheme();
  const { t } = useLanguage();
  if (!chart || !Array.isArray(chart.rows) || chart.rows.length === 0) return null;
  const { chartType, x, y, rows, title, truncated } = chart;
  const axisColor = theme.palette.text.secondary;
  const gridColor = alpha(theme.palette.text.primary, 0.08);
  const tooltipStyle = {
    background: theme.palette.background.paper,
    border: `1px solid ${alpha(theme.palette.text.primary, 0.15)}`,
    borderRadius: 6,
    fontSize: 12,
  };
  const manyPoints = rows.length > 24;

  let body;
  if (chartType === "pie") {
    body = (
      <PieChart>
        <Pie data={rows} dataKey={y[0]} nameKey={x} outerRadius={80} innerRadius={40} paddingAngle={1}>
          {rows.map((_r, i) => (
            <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Pie>
        <Tooltip contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
      </PieChart>
    );
  } else if (chartType === "line") {
    body = (
      <LineChart data={rows} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
        <CartesianGrid stroke={gridColor} vertical={false} />
        <XAxis dataKey={x} tick={{ fontSize: 10, fill: axisColor }} interval={manyPoints ? "preserveStartEnd" : 0} />
        <YAxis tick={{ fontSize: 10, fill: axisColor }} />
        <Tooltip contentStyle={tooltipStyle} />
        {y.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
        {y.map((k, i) => (
          <Line key={k} type="monotone" dataKey={k} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} dot={!manyPoints} />
        ))}
      </LineChart>
    );
  } else {
    body = (
      <BarChart data={rows} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
        <CartesianGrid stroke={gridColor} vertical={false} />
        <XAxis dataKey={x} tick={{ fontSize: 10, fill: axisColor }} interval={manyPoints ? "preserveStartEnd" : 0} />
        <YAxis tick={{ fontSize: 10, fill: axisColor }} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: alpha(theme.palette.primary.main, 0.08) }} />
        {y.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
        {y.map((k, i) => (
          <Bar key={k} dataKey={k} fill={PALETTE[i % PALETTE.length]} radius={[3, 3, 0, 0]} maxBarSize={36} />
        ))}
      </BarChart>
    );
  }

  return (
    <Box
      data-testid="chat-chart"
      sx={{
        mt: 1,
        p: 1,
        borderRadius: 1.5,
        border: `1px solid ${alpha(theme.palette.text.primary, 0.1)}`,
        background: theme.palette.background.paper,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mb: 0.5, px: 0.5 }}>
        <Box sx={{ fontSize: "0.78rem", fontWeight: 700, flex: 1 }}>
          {title || `${y.join(", ")} · ${x}`}
        </Box>
        {truncated && (
          <Chip size="small" label={t("chat.chart.truncated", { count: rows.length })} sx={{ height: 18, fontSize: "0.6rem" }} />
        )}
      </Box>
      <Box sx={{ width: "100%", height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          {body}
        </ResponsiveContainer>
      </Box>
    </Box>
  );
}
