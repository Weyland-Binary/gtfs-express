/**
 * RefusalNotice — a refusal of the server, in place, with what to do next
 * (a banner in the section concerned, never a snackbar).
 *
 * It renders refusalToAction's answer: a title, one sentence, the actions
 * the host can perform there, and the technical text folded behind
 * "Details" with "Copy the details". The banner is `role="alert"` and takes
 * the focus when it appears (programmatic focus, RGAA 7.1 / 11.10) — unless
 * the refusal sends the focus elsewhere (`focus: "name"`: the host focuses
 * the acknowledgement's name field) and the host says it handles that
 * (`manageFocus: false`). A code the table does not know renders the
 * default branch — "Unexpected error — the server answered {status} {code}"
 * with Try again · Copy the details — so a refusal is never a blank.
 *
 *   <RefusalNotice refusal={errOrNormalised} onAction={(id) => …} supported={["retry", "focusItems"]}>
 *     {children: what the section adds under the sentence (a list, an inline code field)}
 *   </RefusalNotice>
 *
 * `supported` lists the action ids the host handles (null: every one it is
 * given); `copy` is always handled here. `testid` defaults to
 * "refusal-notice"; the node carries `data-code` (the server's code, or
 * "default").
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, ButtonBase, Collapse, Typography, alpha, useTheme } from "@mui/material";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { useLanguage } from "../../contexts/LanguageContext";
import { refusalToAction } from "../../utils/refusalToAction";

// Kinds that ask something of the person rather than report a failure: an information tone.
const INFO_KINDS = new Set(["acknowledge", "stale", "access", "edit_required", "invalid"]);

const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

const APP_ACTIONS = { goDraft: "gtfs:enter-edit-mode", openDecision: "gtfs:open-decision" };

export default function RefusalNotice({ refusal, onAction = null, supported = null, manageFocus = true, testid = "refusal-notice", children = null, sx = {} }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const view = useMemo(() => (refusal ? refusalToAction(refusal, t) : null), [refusal, t]);

  // The banner takes the focus when a refusal arrives, unless the host moves it to the field concerned.
  useEffect(() => {
    if (!view || !manageFocus || view.focus === "name") return;
    ref.current?.focus?.();
  }, [view, manageFocus]);
  useEffect(() => {
    setCopied(false);
    setOpen(false);
  }, [refusal]);

  if (!view) return null;
  const tone = view.known && INFO_KINDS.has(view.kind) ? theme.palette.warning.main : theme.palette.error.main;
  const Icon = view.known && INFO_KINDS.has(view.kind) ? InfoOutlinedIcon : ErrorOutlineIcon;
  // The draft's own ways (« Aller au brouillon », « Appliquer le brouillon ») are the app's, wherever the notice shows.
  const can = (id) => id === "copy" || APP_ACTIONS[id] || (Boolean(onAction) && (!supported || supported.includes(id)));
  const actions = view.actions.filter((a) => can(a.id) && !(a.id === "copy" && !view.detail));

  const act = async (id) => {
    if (id === "copy") {
      setCopied(await copyText(view.detail));
      return;
    }
    if (APP_ACTIONS[id]) {
      window.dispatchEvent(new CustomEvent(APP_ACTIONS[id]));
      return;
    }
    onAction?.(id, view);
  };

  return (
    <Box ref={ref} tabIndex={-1} role="alert" data-testid={testid} data-code={view.code || "default"} data-known={view.known ? "true" : "false"} sx={{ px: 1.5, py: 1, borderRadius: "12px", outline: "none", border: `1px solid ${alpha(tone, 0.35)}`, background: alpha(tone, theme.palette.mode === "dark" ? 0.14 : 0.07), "&:focus-visible": { boxShadow: `0 0 0 2px ${alpha(tone, 0.6)}` }, ...sx }}>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
        <Icon sx={{ fontSize: 18, color: tone, mt: 0.15, flexShrink: 0 }} aria-hidden />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography component="p" sx={{ fontSize: "0.8rem", fontWeight: 800, lineHeight: 1.35 }} data-testid={`${testid}-title`}>
            {view.title}
          </Typography>
          <Typography component="p" sx={{ fontSize: "0.76rem", lineHeight: 1.5, color: "text.primary", mt: 0.25 }} data-testid={`${testid}-body`}>
            {view.body}
          </Typography>
          {children}
          {actions.length > 0 && (
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75, mt: 0.75 }}>
              {actions.map((a, i) => (
                <Button key={a.id} size="small" variant={i === 0 && a.id !== "copy" ? "contained" : "text"} disableElevation onClick={() => act(a.id)} data-testid={`${testid}-action-${a.id}`} sx={{ textTransform: "none", fontWeight: 700, fontSize: "0.74rem", borderRadius: 99, px: 1.25, py: 0.25 }}>
                  {a.id === "copy" && copied ? t("status.message.copied") : a.label}
                </Button>
              ))}
            </Box>
          )}
        </Box>
      </Box>
      {view.detail ? (
        <>
          <ButtonBase onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid={`${testid}-details`} sx={{ ml: 3.25, mt: 0.5, borderRadius: 1, px: 0.25, fontSize: "0.66rem", fontWeight: 600, color: "text.secondary", display: "inline-flex", alignItems: "center", gap: 0.25 }}>
            {t("error.human.details")}
            <ExpandMoreIcon sx={{ fontSize: 14, transform: open ? "rotate(180deg)" : "none", transition: "transform 150ms" }} />
          </ButtonBase>
          <Collapse in={open} unmountOnExit>
            <Box component="pre" lang="en" data-testid={`${testid}-detail`} sx={{ m: 0, mt: 0.5, ml: 3.25, p: 0.75, borderRadius: 1, fontSize: "0.64rem", lineHeight: 1.4, fontFamily: "monospace", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "text.secondary", background: alpha(theme.palette.text.primary, 0.05), maxHeight: 160, overflowY: "auto" }}>
              {view.detail}
            </Box>
          </Collapse>
        </>
      ) : null}
    </Box>
  );
}
