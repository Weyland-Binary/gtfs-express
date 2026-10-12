/**
 * NeedsPanel — "What we need from you": what the system still needs to
 * design a network that matches the request, most important first, each
 * with why it matters and one click to where it is given. The service
 * levers put a price on the choices: the fleet and the yearly cost as
 * planned, and with another peak headway or without weekend service.
 *
 *   NeedsChip  the header chip ("2 key inputs missing")
 *   NeedsPanel the list and the levers (in a dialog)
 *
 * Plain words only: a partial territory names the data that is missing
 * (not the endpoints that failed — those are folded behind "Details"),
 * clauses are quoted by their text rather than their ids. The levers are
 * costed on the routed geometry, like the studio's footer.
 */

import React, { useState } from "react";
import { Box, Button, ButtonBase, Chip, Collapse, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import PendingActionsOutlinedIcon from "@mui/icons-material/PendingActionsOutlined";
import TaskAltOutlinedIcon from "@mui/icons-material/TaskAltOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { fmtMoney } from "./PlanCards";
import { territoryGaps } from "../../utils/humanError";

const IMPACT_COLOR = (impact, theme) => ({ high: theme.palette.error.main, medium: theme.palette.warning.dark, low: theme.palette.text.secondary })[impact];

/**
 * Params in the reader's words: lists joined, money formatted, the failed
 * sources named by the data they carry, clause ids replaced by the clause
 * text (the ids stay in expert mode).
 */
const paramsFor = (n, t, { clauses = [], expert = false } = {}) => {
  const p = { ...(n.params || {}) };
  if (Array.isArray(p.fields)) p.fields = p.fields.map((f) => t(`network.settings.field.${f === "timezone" ? "timezone_short" : f}`)).join(", ");
  if (Array.isArray(p.topics)) p.topics = p.topics.join(", ");
  if (Array.isArray(p.gaps)) p.gaps = (territoryGaps(p.gaps, t)?.sources || []).join(", ");
  if (Array.isArray(p.ids)) {
    const text = new Map((clauses || []).map((c) => [c.id, c.text]));
    p.ids = p.ids.map((id) => (text.get(id) ? `${t("network.needs.clauseQuote", { text: text.get(id) })}${expert ? ` (${id})` : ""}` : id)).join(", ");
  }
  if (p.cost_year != null) p.cost = fmtMoney(p.cost_year, p.currency || "EUR");
  return p;
};

/** The raw text behind a need (the sources' own errors), folded. */
function Details({ text }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <Box>
      <ButtonBase onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="need-details" sx={{ borderRadius: 1, px: 0.25, fontSize: "0.66rem", fontWeight: 600, color: "text.secondary", display: "inline-flex", alignItems: "center", gap: 0.25 }}>
        {t("error.human.details")}
        <ExpandMoreIcon sx={{ fontSize: 14, transform: open ? "rotate(180deg)" : "none", transition: "transform 150ms" }} />
      </ButtonBase>
      <Collapse in={open} unmountOnExit>
        <Box component="pre" data-testid="need-details-text" sx={{ m: 0, mt: 0.25, fontSize: "0.64rem", fontFamily: "monospace", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "text.secondary" }}>
          {text}
        </Box>
      </Collapse>
    </Box>
  );
}

export function NeedsChip({ needs, onClick }) {
  const { t } = useLanguage();
  const theme = useTheme();
  if (!needs) return null;
  const high = needs.counts?.high || 0;
  const color = high ? theme.palette.error.main : theme.palette.success.main;
  return (
    <Tooltip title={t("network.needs.open")}>
      <Chip
        size="small"
        icon={high ? <PendingActionsOutlinedIcon sx={{ fontSize: 14, color: `${color} !important` }} /> : <TaskAltOutlinedIcon sx={{ fontSize: 14, color: `${color} !important` }} />}
        label={high ? t("network.needs.chip", { count: high }) : t("network.needs.chipNone")}
        onClick={onClick}
        data-testid="needs-chip"
        data-high={high}
        sx={{ height: 22, fontSize: "0.66rem", fontWeight: 800, color, background: alpha(color, theme.palette.mode === "dark" ? 0.18 : 0.1) }}
      />
    </Tooltip>
  );
}

export default function NeedsPanel({ needs, levers = null, onAction, clauses = [], expert = false }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const list = needs?.needs || [];
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }} data-testid="needs-panel">
      <Typography component="h3" sx={theme.studio ? { fontWeight: 600, fontSize: "0.86rem" } : { fontWeight: 800, fontSize: "1rem" }}>{t("network.needs.title")}</Typography>
      <Typography sx={{ fontSize: "0.76rem", color: "text.secondary" }}>{t("network.needs.subtitle")}</Typography>
      {list.length === 0 && <Typography sx={{ fontSize: "0.8rem", color: "success.main" }}>{t("network.needs.none")}</Typography>}
      <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0 }}>
        {list.map((n) => {
          const params = paramsFor(n, t, { clauses, expert });
          const color = IMPACT_COLOR(n.impact, theme);
          return (
            <Box component="li" key={n.id} data-testid="need" data-need={n.id} data-impact={n.impact} sx={{ display: "flex", gap: 1, alignItems: "flex-start", py: 0.75, borderTop: `1px solid ${alpha(theme.palette.divider, 0.6)}`, "&:first-of-type": { borderTop: "none" } }}>
              {/* The dot only repeats the impact said in words next to the need (a div cannot carry a label, RGAA 7.1). */}
              <Box aria-hidden="true" sx={{ width: 8, height: 8, borderRadius: "50%", background: color, mt: 0.8, flexShrink: 0 }} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontSize: "0.8rem", fontWeight: 700 }}>
                  {t(`network.needs.${n.id}`, params)}
                  <Box component="span" sx={{ ml: 0.75, fontSize: "0.62rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, color }}>
                    {t(`network.needs.impact.${n.impact}`)} · {t(`network.needs.state.${n.state}`)}
                  </Box>
                </Typography>
                <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{t(`network.needs.${n.id}.why`, params)}</Typography>
                {Array.isArray(n.params?.gaps) && n.params.gaps.length > 0 && <Details text={n.params.gaps.join("\n")} />}
              </Box>
              {n.action && onAction && (
                <Button size="small" onClick={() => onAction(n)} data-testid={`need-action-${n.id}`} sx={{ textTransform: "none", fontWeight: 700, flexShrink: 0, fontSize: "0.72rem" }}>
                  {t(`network.needs.action.${n.action}`)}
                </Button>
              )}
            </Box>
          );
        })}
      </Box>
      {levers?.base && (
        <Box data-testid="levers" sx={{ mt: 0.5 }}>
          <Typography sx={{ fontSize: "0.8rem", fontWeight: 800 }}>{t("network.levers.title")}</Typography>
          <Box component="table" sx={{ width: "100%", borderCollapse: "collapse", fontSize: "0.74rem", "& td, & th": { py: 0.4, px: 0.5, textAlign: "left", borderTop: `1px solid ${alpha(theme.palette.divider, 0.5)}` }, "& th": { fontWeight: 700, color: "text.secondary" }, "& td.num": { textAlign: "right", fontVariantNumeric: "tabular-nums" } }}>
            <thead>
              <tr>
                <th>{t("network.levers.choice")}</th>
                <th style={{ textAlign: "right" }}>{t("network.levers.fleet")}</th>
                <th style={{ textAlign: "right" }}>{t("network.levers.cost")}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <strong>{t("network.levers.base")}</strong>
                </td>
                <td className="num">{levers.base.fleet}</td>
                <td className="num">{fmtMoney(levers.base.cost_year, levers.currency)}</td>
              </tr>
              {levers.variants.map((v) => (
                <tr key={`${v.id}-${v.params?.minutes ?? ""}`}>
                  <td>{v.id === "peak_headway" ? t("network.levers.peak", { minutes: v.params.minutes }) : t(`network.levers.${v.id === "no_saturday" ? "noSaturday" : "noSunday"}`)}</td>
                  <td className="num">
                    {v.fleet} <span style={{ color: theme.palette.text.secondary }}>({v.delta_fleet >= 0 ? "+" : ""}{v.delta_fleet})</span>
                  </td>
                  <td className="num">
                    {fmtMoney(v.cost_year, levers.currency)} <span style={{ color: theme.palette.text.secondary }}>({v.delta_cost >= 0 ? "+" : "−"}{fmtMoney(Math.abs(v.delta_cost), levers.currency)})</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </Box>
        </Box>
      )}
    </Box>
  );
}
