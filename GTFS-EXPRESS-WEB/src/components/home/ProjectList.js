/**
 * ProjectList — "Mes travaux" on Home: the projects of this browser (or of
 * the account), the last written first, each one line to resume (target
 * design §4 A0, §9, D5).
 *
 *   Rentrée 2026 — Réseau Vendôme   Modifier · ③ Changement · scénario A · hier 17:02   [Reprendre]
 *   Réseau du Pays de X (étude)      Concevoir · ⑤ Livraison · v1 livrée · 12 sept.       [Ouvrir]
 *
 * A row says the job, the step the project was left at, its scenario or its
 * last version, and when it was last written — in the interface's language
 * (D47) — and when the server keeps it until (the retention, D49: « conservé
 * jusqu'au … », said in orange from seven days before). "Reprendre" (or
 * "Ouvrir" once delivered) opens the project at its step (/p/:id). The list
 * is the server's (the workspace) cached in the browser: it survives a new
 * tab, a reload, a cleared cache — never another browser's projects (D39).
 *
 * A project the server refused to keep (the quota of projects per browser,
 * its size) says so on its row (`project-not-kept`) with « Réessayer »; and
 * every row can be deleted (`project-delete`), confirmed in place
 * (`project-delete-confirm`, « Annuler » keeps it) — the quota's refusal
 * says « Supprimez-en un », this is where. A deletion frees a place: the
 * projects refused for the quota are offered to the server again.
 */

import React, { useState } from "react";
import { Box, Button, Typography, alpha, useTheme } from "@mui/material";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { useLanguage } from "../../contexts/LanguageContext";
import { formatDate, formatDateTime } from "../../utils/formatDate";
import { activeScenarioOf, latestVersionOf, removeProject, retryLocal, useProjectSync } from "../../utils/projectStore";
import { refusalToAction } from "../../utils/refusalToAction";
import { stepFor, stepHeading } from "../steps/StepNav";

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_WARNING_DAYS = 7;

/** Days left before a project's retention ends (rounded up), or null without one. */
export const daysLeft = (project, now = Date.now()) => {
  const until = Date.parse(project?.retention_until || "");
  return Number.isFinite(until) ? Math.max(0, Math.ceil((until - now) / DAY_MS)) : null;
};

/** What a row says of a project, in words: [job, step, scenario or version, last written]. */
export const projectLine = (project, t, language) => {
  const job = t(project.job === "modify" ? "flow.modify.title" : "flow.create.title");
  const step = stepHeading(t, stepFor(project.step || 1, project.job), project.job);
  const version = latestVersionOf(project);
  const scenario = activeScenarioOf(project);
  const state = project.delivery?.version_id
    ? t("version.delivered", { n: (project.versions || []).find((v) => v.id === project.delivery.version_id)?.n ?? version?.n ?? 1 })
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
      <Button size="small" color="inherit" startIcon={<DeleteOutlineIcon />} onClick={() => setAsking(true)} data-testid="project-delete" aria-label={`${t("home.project.delete")} — ${name}`} sx={{ textTransform: "none", fontWeight: 600, color: "text.secondary", flexShrink: 0 }}>
        {t("home.project.delete")}
      </Button>
    );
  }
  return (
    <Box role="group" aria-label={t("home.project.deleteConfirm", { name })} data-testid="project-delete-ask" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 0.5, width: "100%" }}>
      <Typography sx={{ fontSize: "0.76rem", fontWeight: 700, flex: "1 1 220px" }}>{t("home.project.deleteConfirm", { name })}</Typography>
      <Button size="small" autoFocus onClick={() => setAsking(false)} data-testid="project-delete-cancel" sx={{ textTransform: "none", fontWeight: 700 }}>
        {t("home.project.deleteCancel")}
      </Button>
      <Button size="small" color="error" variant="outlined" onClick={() => onDelete?.(project)} data-testid="project-delete-confirm" sx={{ textTransform: "none", fontWeight: 800 }}>
        {t("home.project.delete")}
      </Button>
    </Box>
  );
}

export default function ProjectList({ projects = [], onOpen, onDelete = (p) => removeProject(p.id), now = Date.now() }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  if (!projects.length) return null;
  return (
    <Box component="section" aria-labelledby="home-projects-title" data-testid="home-projects" sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
      <Typography id="home-projects-title" component="h2" sx={{ fontSize: "0.95rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", color: "text.secondary" }}>
        {t("home.projects")} ({projects.length})
      </Typography>
      <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.75 }}>
        {projects.map((p) => {
          const left = daysLeft(p, now);
          const soon = left !== null && left <= RETENTION_WARNING_DAYS;
          const delivered = Boolean(p.delivery);
          return (
            <Box
              component="li"
              key={p.id}
              data-testid="project-row"
              data-project-id={p.id}
              data-job={p.job}
              sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1, px: 1.5, py: 1, borderRadius: "12px", border: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper }}
            >
              <Box sx={{ flex: "1 1 320px", minWidth: 0 }}>
                <Typography sx={{ fontSize: "0.9rem", fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.name}>
                  {p.name || t("home.project.untitled")}
                </Typography>
                <Typography sx={{ fontSize: "0.76rem", color: "text.secondary" }}>{projectLine(p, t, language).join(" · ")}</Typography>
                {left !== null && (
                  <Typography data-testid="project-retention" data-soon={soon ? "true" : "false"} sx={{ fontSize: "0.72rem", color: soon ? "warning.dark" : "text.secondary", fontWeight: soon ? 700 : 400 }}>
                    {t(soon ? "home.project.retentionSoon" : "home.project.retention", { date: formatDate(p.retention_until, language), days: left })}
                  </Typography>
                )}
                <NotKept project={p} />
              </Box>
              <Button
                size="small"
                variant={delivered ? "outlined" : "contained"}
                disableElevation
                startIcon={<FolderOpenOutlinedIcon />}
                onClick={() => onOpen?.(p)}
                data-testid="project-resume"
                aria-label={`${t(delivered ? "home.open" : "home.resume")} — ${p.name || t("home.project.untitled")}`}
                sx={{ textTransform: "none", fontWeight: 800, borderRadius: 99, flexShrink: 0, ...(soon ? { boxShadow: `0 0 0 2px ${alpha(theme.palette.warning.main, 0.35)}` } : {}) }}
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
