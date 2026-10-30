/**
 * « Avant | Après » over the reader of a modify project: the working copy, or the draft (by hand its own session,
 * written there; with a brief the feed the turn produces, read only). Keeps the source feed, the draft and the
 * applied version visibly distinct; once applied it only says so, the working copy being vN.
 */

import React from "react";
import { Box, Button, ButtonBase, CircularProgress, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import CheckCircleOutlineRoundedIcon from "@mui/icons-material/CheckCircleOutlineRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { countWords } from "../../utils/countWords";

const MAX_CHIPS = 8;

function Segment({ value, side, onSide, disabled, testid, children }) {
  const theme = useTheme();
  const on = side === value;
  const tone = value === "after" ? theme.palette.warning.dark : theme.palette.text.primary;
  return (
    <ButtonBase
      onClick={() => !on && onSide(value)}
      disabled={disabled}
      role="radio"
      aria-checked={on ? "true" : "false"}
      data-testid={testid}
      sx={{ height: 30, px: 1.5, display: "inline-flex", alignItems: "center", gap: 0.75, borderRadius: "8px", fontSize: "0.8rem", fontWeight: on ? 700 : 500, color: on ? tone : "text.secondary", backgroundColor: on ? theme.palette.background.paper : "transparent", boxShadow: on ? `0 1px 2px ${alpha(theme.palette.common.black, 0.12)}, 0 0 0 1px ${theme.palette.divider}` : "none", transition: "background-color 120ms, color 120ms", "&:hover": { color: on ? tone : "text.primary" }, "&.Mui-disabled": { opacity: 0.5 }, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 1 } }}
    >
      {children}
    </ButtonBase>
  );
}

// `draft`: { operations, touched: [{ route, label, date }], simulating, applied: n | null, previewId, draftSession } | null;
// `compare`: { label, date, before, after, added, removed } | null, the selected line's trips.
export default function ReaderLens({ draft = null, side = "before", onSide, compare = null, onLine = null, onReport = null, editing = false, retouching = false, compact = false }) {
  const { t } = useLanguage();
  const theme = useTheme();
  if (!draft) return null;
  const applied = draft.applied !== null && draft.applied !== undefined && !draft.previewId && !draft.draftSession;
  if (applied) {
    return (
      <Box data-testid="reader-lens" data-state="applied" data-side="before" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1, px: 2, py: 0.75, borderBottom: `1px solid ${theme.palette.divider}`, backgroundColor: alpha(theme.palette.success.main, theme.palette.mode === "dark" ? 0.12 : 0.06) }}>
        <CheckCircleOutlineRoundedIcon aria-hidden sx={{ fontSize: 18, color: "success.main" }} />
        <Typography sx={{ fontSize: "0.82rem", fontWeight: 600 }}>{t("lens.applied", { n: draft.applied })}</Typography>
      </Box>
    );
  }
  const after = side === "after";
  const simulating = Boolean(draft.simulating) && !draft.previewId && !draft.draftSession;
  // A draft by hand exists from its opening (« Après » is where it is written); otherwise no bar until something is written.
  if (!draft.previewId && !draft.draftSession && !simulating && !(draft.operations > 0)) return null;
  const afterOpen = Boolean(draft.previewId || draft.draftSession);
  const touched = draft.touched || [];
  return (
    <Box data-testid="reader-lens" data-side={side} data-state={simulating ? "simulating" : "draft"} sx={{ display: "flex", flexDirection: "column", gap: 0.5, px: 2, py: 0.75, borderBottom: `1px solid ${after ? alpha(theme.palette.warning.main, 0.5) : theme.palette.divider}`, backgroundColor: after ? alpha(theme.palette.warning.main, theme.palette.mode === "dark" ? 0.14 : 0.07) : theme.palette.background.paper, transition: "background-color 160ms" }}>
      <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 1.5, rowGap: 0.75 }}>
        <Box role="radiogroup" aria-label={t("lens.label")} sx={{ display: "inline-flex", p: "3px", gap: "2px", borderRadius: "10px", backgroundColor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.1 : 0.06) }}>
          <Segment value="before" side={side} onSide={onSide} testid="reader-lens-before">
            {t("lens.before")}
          </Segment>
          <Segment value="after" side={side} onSide={onSide} disabled={!afterOpen} testid="reader-lens-after">
            {simulating ? <CircularProgress size={12} color="inherit" /> : <VisibilityOutlinedIcon aria-hidden sx={{ fontSize: 16 }} />}
            {t("lens.after")}
          </Segment>
        </Box>
        {(!compact || simulating) && (
        <Typography data-testid="reader-lens-said" sx={{ flex: "1 1 260px", minWidth: 0, fontSize: "0.8rem", color: after ? "warning.dark" : "text.secondary", fontWeight: after ? 600 : 500, lineHeight: 1.45 }}>
          {simulating ? t("lens.simulating") : after ? t(retouching ? "lens.after.retouch" : "lens.after.said", { count: draft.operations || 0 }) : t(retouching ? "lens.before.readOnly" : "lens.before.said", { count: draft.operations || 0 })}
          {after && editing && !retouching ? ` ${t("lens.editSuspended")}` : ""}
        </Typography>
        )}
      </Box>
      {touched.length > 0 && (
        <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 0.75 }}>
          <Typography component="span" sx={{ fontSize: "0.74rem", color: "text.secondary", fontWeight: 600 }}>
            {t("lens.touched", { count: touched.length })}
          </Typography>
          {touched.slice(0, MAX_CHIPS).map((line) => (
            <Tooltip key={line.route} title={t("lens.line.open", { line: line.label })}>
              <ButtonBase onClick={() => onLine?.(line)} data-testid="reader-lens-line" data-route={line.route} sx={{ height: 24, px: 1, borderRadius: 99, fontSize: "0.74rem", fontWeight: 700, color: after ? "warning.dark" : "text.primary", border: `1px solid ${after ? alpha(theme.palette.warning.main, 0.6) : theme.palette.divider}`, backgroundColor: theme.palette.background.paper, "&:hover": { borderColor: theme.palette.primary.main, color: "primary.main" } }}>
                {line.label}
              </ButtonBase>
            </Tooltip>
          ))}
          {touched.length > MAX_CHIPS && (
            <Typography component="span" sx={{ fontSize: "0.74rem", color: "text.secondary" }}>
              {t("lens.touched.more", { count: touched.length - MAX_CHIPS })}
            </Typography>
          )}
        </Box>
      )}
      {after && compare && (
        <Typography data-testid="reader-lens-compare" data-added={compare.added} data-removed={compare.removed} sx={{ fontSize: "0.78rem", fontWeight: 600, color: "text.primary", fontVariantNumeric: "tabular-nums" }}>
          {t("lens.compare", { line: compare.label, date: compare.date, before: compare.before, after: compare.after })}
          {compare.added > 0 ? ` · ${countWords(t, "lens.compare.added", compare.added)}` : ""}
          {compare.removed > 0 ? ` · ${countWords(t, "lens.compare.removed", compare.removed)}` : ""}
        </Typography>
      )}
      {after && !compact && (
        <Typography component="div" data-testid="reader-lens-proof" sx={{ fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.45 }}>
          {t("change.map.notProof")}
          {onReport && (
            <Button size="small" onClick={onReport} data-testid="reader-lens-report" sx={{ ml: 0.5, p: 0, minWidth: 0, verticalAlign: "baseline", textTransform: "none", fontSize: "0.72rem", fontWeight: 700 }}>
              {t("lens.report")}
            </Button>
          )}
        </Typography>
      )}
    </Box>
  );
}
