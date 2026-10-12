/**
 * RealtimeCheckDialog — a GTFS-Realtime feed checked against the loaded
 * static feed: paste the feed URL (protobuf or JSON), get the entity
 * counts and the findings a journey planner would trip on (unknown
 * trips or stops, sequence and time order, absurd delays, vehicles far
 * from the network, stale timestamps, alerts pointing nowhere).
 */

import React, { useCallback, useState } from "react";
import { Box, Button, Chip, CircularProgress, Dialog, TextField, Typography, alpha, useTheme } from "@mui/material";
import SensorsOutlinedIcon from "@mui/icons-material/SensorsOutlined";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";

const RT_URL_KEY = "gtfs:realtime-url";

export default function RealtimeCheckDialog({ open, onClose }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [url, setUrl] = useState(() => {
    try {
      return localStorage.getItem(RT_URL_KEY) || "";
    } catch {
      return "";
    }
  });
  const [state, setState] = useState({ status: "idle" }); // idle | running | done | error

  const run = useCallback(async () => {
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) return;
    try {
      localStorage.setItem(RT_URL_KEY, u);
    } catch {
      /* storage disabled */
    }
    setState({ status: "running" });
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/realtime/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: u }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
      setState({ status: "done", result: data });
    } catch (err) {
      setState({ status: "error", error: err.message });
    }
  }, [url]);

  const r = state.result;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth data-testid="realtime-dialog">
      <Box sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.25 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <SensorsOutlinedIcon sx={{ color: theme.palette.primary.main }} />
          <Box sx={{ flex: 1 }}>
            <Typography sx={{ fontWeight: 800, fontSize: "1rem" }}>{t("realtime.title")}</Typography>
            <Typography sx={{ fontSize: "0.76rem", color: "text.secondary" }}>{t("realtime.intro")}</Typography>
          </Box>
        </Box>
        <Box sx={{ display: "flex", gap: 0.75 }}>
          <TextField size="small" fullWidth placeholder="https://…/gtfs-rt/trip-updates.pb" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} inputProps={{ "data-testid": "realtime-url" }} />
          <Button variant="contained" disableElevation disabled={state.status === "running" || !/^https?:\/\//i.test(url.trim())} onClick={run} data-testid="realtime-run" sx={{ textTransform: "none", fontWeight: 700, whiteSpace: "nowrap" }}>
            {state.status === "running" ? <CircularProgress size={16} color="inherit" /> : t("realtime.run")}
          </Button>
        </Box>
        {state.status === "error" && <Typography sx={{ fontSize: "0.8rem", color: "error.main" }}>{state.error}</Typography>}
        {r && (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }} data-testid="realtime-result">
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
              <Chip size="small" label={t("realtime.entities", { count: r.summary.entities })} sx={{ height: 22, fontSize: "0.68rem" }} />
              <Chip size="small" label={t("realtime.tripUpdates", { count: r.summary.trip_updates })} sx={{ height: 22, fontSize: "0.68rem" }} />
              <Chip size="small" label={t("realtime.vehicles", { count: r.summary.vehicle_positions })} sx={{ height: 22, fontSize: "0.68rem" }} />
              <Chip size="small" label={t("realtime.alerts", { count: r.summary.alerts })} sx={{ height: 22, fontSize: "0.68rem" }} />
              <Chip size="small" icon={r.ok ? <CheckCircleOutlineIcon sx={{ fontSize: 14 }} /> : <ErrorOutlineIcon sx={{ fontSize: 14 }} />} color={r.ok ? "success" : "error"} variant="outlined" label={r.ok ? t("realtime.ok", { warnings: r.counts.warning }) : t("realtime.errors", { errors: r.counts.error, warnings: r.counts.warning })} data-testid="realtime-verdict" sx={{ height: 22, fontSize: "0.68rem", fontWeight: 700 }} />
            </Box>
            {r.findings.map((f) => (
              <Box key={f.code} data-testid="realtime-finding" sx={{ display: "flex", gap: 0.75, alignItems: "flex-start", px: 1, py: 0.6, borderRadius: 1.5, background: alpha(f.severity === "error" ? theme.palette.error.main : theme.palette.warning.main, 0.06), fontSize: "0.76rem" }}>
                {f.severity === "error" ? <ErrorOutlineIcon sx={{ fontSize: 15, color: "error.main", mt: 0.2 }} /> : <WarningAmberIcon sx={{ fontSize: 15, color: "warning.dark", mt: 0.2 }} />}
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontSize: "0.76rem", fontWeight: 700 }}>
                    {f.message} <span style={{ fontWeight: 400, color: theme.palette.text.secondary }}>×{f.count}</span>
                  </Typography>
                  {f.samples?.length > 0 && (
                    <Typography sx={{ fontSize: "0.66rem", color: "text.secondary", fontFamily: "monospace" }} noWrap>
                      {f.samples.slice(0, 3).map((s) => Object.entries(s).map(([k, v]) => `${k}=${v}`).join(" ")).join(" · ")}
                    </Typography>
                  )}
                </Box>
              </Box>
            ))}
          </Box>
        )}
        <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
          <Button size="small" onClick={onClose} sx={{ textTransform: "none" }}>
            {t("app.close")}
          </Button>
        </Box>
      </Box>
    </Dialog>
  );
}
