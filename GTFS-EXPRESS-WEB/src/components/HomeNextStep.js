/**
 * HomeNextStep — the overview's "Prochaine étape" card (target design §3.1,
 * §12.1, D48): what one does next with the network on screen.
 *
 * "Modifier ce réseau" (`open-change-studio`) left the top bar with WP4 and
 * lives here now: it opens a project that modifies this network — the
 * network is its reference, the project opens at its change step (/modifier
 * ?network=…). The top bar keeps the brand, the language, the theme and the
 * account; the way into the work is on the network it applies to.
 *
 * The reader is the way into a change and stays its context (the owner's
 * direction of 2026-10-07): the card hands over the line the person chose
 * here (`focusLabel`: GTFSApp's reader focus, in focus on the change's map),
 * and it never starts a second project in silence —
 *
 *   existing   a modify project of this browser already works on this
 *              network: « Reprendre » it (`resume-modify-project`, its own
 *              step), named with its version; a new project stays offered
 *              beside it (`open-change-studio`), the person's own choice:
 *              it asks for one (`fresh`), where « Modifier ce réseau »
 *              elsewhere joins the project already working on the network;
 *   inProject  the reader inside a modify project (/p/:id/voir) shows that
 *              project's working copy: the way back to its change
 *              (`next-step-back-to-change`) — « Modifier ce réseau » there
 *              would bind a second project to the same working copy.
 */

import React from "react";
import { Box, Button, Typography, alpha, useTheme } from "@mui/material";
import AutoFixHighOutlinedIcon from "@mui/icons-material/AutoFixHighOutlined";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import { useLanguage } from "../contexts/LanguageContext";

/** Ask the app to open a project that modifies the network open here (GTFSApp handles the event); `fresh`: a new one. */
export const openModifyProject = ({ fresh = false } = {}) => window.dispatchEvent(new CustomEvent("gtfs:open-change-studio", fresh ? { detail: { fresh: true } } : undefined));

// `existing`: { name, words, onResume } — the last modify project of this browser on this network; `inProject`:
// { name, onBack } — the reader inside that project; `focusLabel`: the line chosen here, carried into the change.
// `dense`: the overview's title row (2026-10-08) — the title an overline, the words and the buttons smaller, one row.
export default function HomeNextStep({ onModify = openModifyProject, existing = null, inProject = null, focusLabel = null, dense = false, sx = {} }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const color = theme.palette.ai?.main || theme.palette.primary.main;
  const size = dense ? "small" : "medium";
  const strong = { textTransform: "none", fontWeight: 800, borderRadius: 99, whiteSpace: "nowrap", background: color, "&:hover": { background: alpha(color, 0.85) }, ...(dense ? { px: 1.75 } : {}) };
  const focus = focusLabel ? (
    <Typography data-testid="next-step-focus" sx={{ fontSize: dense ? "0.72rem" : "0.76rem", color: "text.secondary", lineHeight: dense ? 1.35 : 1.5, mt: dense ? 0 : 0.25 }}>
      {t("explorer.next.focus", { line: focusLabel })}
    </Typography>
  ) : null;
  let text;
  let actions;
  if (inProject) {
    text = t("explorer.next.inProject", { name: inProject.name || "" });
    actions = (
      <Button size={size} variant="contained" disableElevation startIcon={<ArrowBackRoundedIcon />} onClick={inProject.onBack} data-testid="next-step-back-to-change" sx={strong}>
        {t("explorer.next.backToChange")}
      </Button>
    );
  } else if (existing) {
    text = t("explorer.next.existing", { name: existing.name || "", state: existing.words || "" });
    actions = (
      <>
        <Button size={size} variant="contained" disableElevation startIcon={<PlayArrowRoundedIcon />} onClick={existing.onResume} data-testid="resume-modify-project" sx={strong}>
          {t("explorer.next.resume")}
        </Button>
        <Button size={size} variant="outlined" startIcon={<AutoFixHighOutlinedIcon />} onClick={() => onModify({ fresh: true })} data-testid="open-change-studio" sx={{ textTransform: "none", fontWeight: 700, borderRadius: 99, whiteSpace: "nowrap" }}>
          {t("explorer.next.newProject")}
        </Button>
      </>
    );
  } else {
    text = t("explorer.next.modify");
    actions = (
      <Button size={size} variant="contained" disableElevation startIcon={<AutoFixHighOutlinedIcon />} onClick={() => onModify()} data-testid="open-change-studio" sx={strong}>
        {t("delivery.modifyNetwork")}
      </Button>
    );
  }
  return (
    <Box component="section" aria-label={t("explorer.next.title")} data-testid="home-next-step" data-variant={inProject ? "in-project" : existing ? "existing" : "new"} sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: dense ? 1.5 : 1.25, px: dense ? 1.5 : 1.75, py: dense ? 0.75 : 1.25, borderRadius: dense ? "12px" : "14px", background: alpha(color, theme.palette.mode === "dark" ? 0.14 : 0.07), ...sx }}>
      <Box sx={{ flex: dense ? "1 1 240px" : "1 1 260px", minWidth: 0 }}>
        <Typography component="h2" sx={dense ? { fontSize: "0.68rem", fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", lineHeight: 1.4 } : { fontSize: "0.9rem", fontWeight: 800 }}>
          {t("explorer.next.title")}
        </Typography>
        <Typography data-testid="next-step-text" sx={{ fontSize: dense ? "0.76rem" : "0.8rem", color: "text.secondary", lineHeight: dense ? 1.35 : 1.5 }}>
          {text}
        </Typography>
        {focus}
      </Box>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>{actions}</Box>
    </Box>
  );
}
