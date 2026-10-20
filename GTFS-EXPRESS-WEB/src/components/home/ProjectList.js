/**
 * ProjectList — "Mes travaux" on Home: the projects of this browser (or of
 * the account), the last written first, in one card whose list scrolls past a
 * few rows.
 *
 *   [✎] Rentrée 2026 — Réseau Vendôme   À la main · 2 modifications · hier 17:02   [Reprendre] [🗑]
 *   [▤] Réseau du Pays de X (étude)      Concevoir · ⑤ Livraison · v1 livrée          [Ouvrir]   [🗑]
 *
 * A row says its way (the draft's kind, in its colour: by hand, with a brief;
 * a design), the step a design was left at, its draft or its last version,
 * and when it was last written — in the interface's language. The retention
 * is said on the row only from seven days before its end (in orange), else
 * in the row's tooltip. "Reprendre" (or
 * "Ouvrir" once delivered) opens the project at its step (/p/:id). The list
 * is the server's (the workspace) cached in the browser: it survives a new
 * tab, a reload, a cleared cache — never another browser's projects.
 *
 * A project the server refused to keep (the quota of projects per browser,
 * its size) says so on its row (`project-not-kept`) with « Réessayer »; and
 * every row can be deleted (`project-delete`), confirmed in place
 * (`project-delete-confirm`, « Annuler » keeps it) — the quota's refusal
 * says « Supprimez-en un », this is where. A deletion frees a place: the
 * projects refused for the quota are offered to the server again.
 */

import React, { useState } from "react";
import { Box, Button, IconButton, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import AltRouteOutlinedIcon from "@mui/icons-material/AltRouteOutlined";
import HubOutlinedIcon from "@mui/icons-material/HubOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { formatDate, formatDateTime } from "../../utils/formatDate";
import { activeScenarioOf, latestVersionOf, removeProject, retryLocal, useProjectSync } from "../../utils/projectStore";
import { draftKindOf, draftOperationsOf } from "../../utils/changeStates";
import { kindToneOf } from "../transform/draftKinds";
import { refusalToAction } from "../../utils/refusalToAction";
import { stepFor, stepHeading } from "../steps/StepNav";

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_WARNING_DAYS = 7;

/** Days left before a project's retention ends (rounded up), or null without one. */
export const daysLeft = (project, now = Date.now()) => {
  const until = Date.parse(project?.retention_until || "");
  return Number.isFinite(until) ? Math.max(0, Math.ceil((until - now) / DAY_MS)) : null;
};

/** What a row says of a project, in words: [job, step (a design only), its draft or its version, last written]. */
export const projectLine = (project, t, language) => {
  const job = t(project.job === "modify" ? "flow.modify.title" : "flow.create.title");
  // A modification is one screen (the reader and its panel, 2026-10-13): its row says its draft or its version, no step.
  const step = project.job === "modify" ? null : stepHeading(t, stepFor(project.step || 1, project.job), project.job);
  const draft = project.job === "modify" ? draftOperationsOf(project) : 0;
  const version = latestVersionOf(project);
  const scenario = activeScenarioOf(project);
  // A delivered version first; then a draft with changes (what is being worked on); then the latest version kept.
  const state = project.delivery?.version_id
    ? t("version.delivered", { n: (project.versions || []).find((v) => v.id === project.delivery.version_id)?.n ?? version?.n ?? 1 })
    : draft > 0
      ? t(draft === 1 ? "work.draft.one" : "work.draft.many", { count: draft })
      : version && version.kind !== "reference"
        ? t(version.kind === "applied" ? "version.applied" : version.kind === "snapshot" ? "home.project.snapshot" : version.kind === "delivered" ? "version.delivered" : "version.built", { n: version.n })
        : scenario
          ? t("home.project.scenario", { name: scenario.name })
          : null;
  return [job, step, state, formatDateTime(project.updated_at, language)].filter(Boolean);
};

/** The server's refusal to keep a project, on its row, with « Réessayer » (null while it keeps it). */
function NotKept({ project }) {
  const { t } = useLanguage();
  const sync = useProjectSync(project.id);
  if (sync?.state !== "local" || !sync.error) return null;
  const view = refusalToAction({ code: sync.refusal?.code || sync.error, status: sync.refusal?.status ?? null, message: "", details: sync.refusal?.details || {} }, t);
  return (
    <Box data-testid="project-not-kept" data-code={view.code || "default"} sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 0.75 }}>
      <Typography sx={{ fontSize: "0.72rem", color: "warning.dark", fontWeight: 700 }}>
        {t("home.project.notKept")} — {view.body}
      </Typography>
      <Button size="small" onClick={() => retryLocal(project.id)} data-testid="project-retry" sx={{ textTransform: "none", fontWeight: 700, py: 0, minHeight: 0 }}>
        {t("refusal.default.action")}
      </Button>
    </Box>
  );
}

/** « Supprimer », confirmed in place: the project and its versions go, here and on the server. */
function DeleteAction({ project, onDelete }) {
  const { t } = useLanguage();
  const [asking, setAsking] = useState(false);
  const name = project.name || t("home.project.untitled");
  if (!asking) {
    return (
      <Tooltip title={t("home.project.delete")}>
        <IconButton size="small" onClick={() => setAsking(true)} data-testid="project-delete" aria-label={`${t("home.project.delete")} — ${name}`} sx={{ color: "text.secondary", flexShrink: 0, "&:hover": { color: "error.main" } }}>
          <DeleteOutlineIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    );
  }
  return (
    <Box role="group" aria-label={t("home.project.deleteConfirm", { name })} data-testid="project-delete-ask" sx={{ display: "flex", alignItems: "center", gap: 0.5, flexShrink: 0 }}>
      <Typography sx={{ fontSize: "0.78rem", fontWeight: 600, color: "error.main", mr: 0.5 }}>{t("home.project.deleteShort")}</Typography>
      <Button size="small" autoFocus onClick={() => setAsking(false)} data-testid="project-delete-cancel" sx={{ textTransform: "none", fontWeight: 700 }}>
        {t("home.project.deleteCancel")}
      </Button>
      <Button size="small" color="error" variant="outlined" onClick={() => onDelete?.(project)} data-testid="project-delete-confirm" sx={{ textTransform: "none", fontWeight: 800 }}>
        {t("home.project.delete")}
      </Button>
    </Box>
  );
}

// Each row's way: the draft's kind in its colour, a design in the brand's.
const wayOf = (project, theme) => {
  if (project.job !== "modify") return { icon: HubOutlinedIcon, tone: theme.palette.primary.main, word: "flow.create.title" };
  const kind = draftKindOf(project);
  if (kind === "hand") return { icon: EditOutlinedIcon, tone: kindToneOf(theme, "hand"), word: "draft.kind.hand.short" };
  if (kind === "brief") return { icon: DescriptionOutlinedIcon, tone: kindToneOf(theme, "brief"), word: "draft.kind.brief.short" };
  return { icon: AltRouteOutlinedIcon, tone: theme.palette.text.secondary, word: "home.project.kind.modify" };
};
// About four rows in sight; the others scroll inside the card.
const LIST_MAX_HEIGHT = 4 * 64;

// `bare`: inside a window (WorksDialog) — no card of its own, a taller list.
export default function ProjectList({ projects = [], onOpen, onDelete = (p) => removeProject(p.id), now = Date.now(), bare = false }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  if (!projects.length) return null;
  return (
    <Box component="section" aria-labelledby="home-projects-title" data-testid="home-projects" sx={bare ? { color: "text.primary" } : { borderRadius: "16px", backgroundColor: theme.palette.background.paper, color: "text.primary", boxShadow: `0 12px 32px ${alpha(theme.palette.common.black, 0.18)}`, overflow: "hidden" }}>
      {/* In a header of its own: Home's titles over its ink (a section's own h2) are white; this one is on the card. */}
      <Box component="header">
        <Typography id="home-projects-title" component="h2" sx={{ px: 2.25, pt: 1.75, pb: 1, fontSize: "1rem", fontWeight: 700, letterSpacing: "-0.01em" }}>
          {t("home.projects")} <Box component="span" sx={{ color: "text.secondary", fontWeight: 500 }}>({projects.length})</Box>
        </Typography>
      </Box>
      <Box component="ul" data-testid="home-projects-list" sx={{ listStyle: "none", m: 0, p: 0, maxHeight: bare ? "min(60vh, 560px)" : LIST_MAX_HEIGHT, overflowY: "auto", borderTop: `1px solid ${theme.palette.divider}` }}>
        {projects.map((p) => {
          const left = daysLeft(p, now);
          const soon = left !== null && left <= RETENTION_WARNING_DAYS;
          const delivered = Boolean(p.delivery);
          const way = wayOf(p, theme);
          const Icon = way.icon;
          const words = projectLine(p, t, language).slice(1);
          const retention = left !== null ? t(soon ? "home.project.retentionSoon" : "home.project.retention", { date: formatDate(p.retention_until, language), days: left }) : null;
          return (
            <Box
              component="li"
              key={p.id}
              data-testid="project-row"
              data-project-id={p.id}
              data-job={p.job}
              title={retention && !soon ? retention : undefined}
              sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2.25, py: 1.25, minHeight: 64, borderBottom: `1px solid ${theme.palette.divider}`, "&:last-of-type": { borderBottom: "none" }, "&:hover": { backgroundColor: alpha(theme.palette.text.primary, 0.03) } }}
            >
              <Box aria-hidden sx={{ width: 36, height: 36, flexShrink: 0, borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center", color: way.tone, backgroundColor: alpha(way.tone, 0.12) }}>
                <Icon sx={{ fontSize: 19 }} />
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontSize: "0.9rem", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.name}>
                  {p.name || t("home.project.untitled")}
                </Typography>
                <Typography sx={{ fontSize: "0.76rem", color: "text.secondary", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <Box component="span" sx={{ color: way.tone, fontWeight: 650 }}>{t(way.word)}</Box>
                  {words.length ? ` · ${words.join(" · ")}` : ""}
                </Typography>
                {retention && soon && (
                  <Typography data-testid="project-retention" data-soon="true" sx={{ fontSize: "0.72rem", color: "warning.dark", fontWeight: 700 }}>
                    {retention}
                  </Typography>
                )}
                <NotKept project={p} />
              </Box>
              <Button
                size="small"
                variant={delivered ? "outlined" : "contained"}
                disableElevation
                onClick={() => onOpen?.(p)}
                data-testid="project-resume"
                aria-label={`${t(delivered ? "home.open" : "home.resume")} — ${p.name || t("home.project.untitled")}`}
                sx={{ textTransform: "none", fontWeight: 700, borderRadius: "10px", px: 2, flexShrink: 0, ...(soon ? { boxShadow: `0 0 0 2px ${alpha(theme.palette.warning.main, 0.35)}` } : {}) }}
              >
                {t(delivered ? "home.open" : "home.resume")}
              </Button>
              <DeleteAction project={p} onDelete={onDelete} />
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
