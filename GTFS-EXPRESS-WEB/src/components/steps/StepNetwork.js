/**
 * StepNetwork — ① Réseau et documents of the Network Studio.
 *
 * « Dites d'où vous partez, joignez ce que vous avez. Tout est enregistré au
 * fur et à mesure. » The page holds:
 *
 *   the project's name            (`project-name`) — the
 *                                 gates said before any work
 *   the workbench                 `workbench`: the map, the lines, the
 *                                 stops, the brief's composer
 *                                 (`network-studio` is on the page from ①)
 *   the network's fingerprint     (`network-fingerprint`) the last version
 *                                 frozen with the project: « Reprendre »
 *                                 brings back exactly that network
 *   the documents                 (`documents-panel`) in sight, with their
 *                                 drop zone (« Déposer le cahier des
 *                                 charges et ses annexes »): kept with the
 *                                 project, same retention, « envoyé à
 *                                 l'assistant » or not (what the person
 *                                 chose — never "read", which no one
 *                                 proved), and what the server knows of
 *                                 them: being kept, kept until a date,
 *                                 still in memory until a time, or « à
 *                                 redéposer » once gone — on a desktop
 *                                 screen, in the Network Studio's column
 *   the deliverables wanted       (`deliverables-panel`) what ⑤ will produce
 *   the retention                 (`retention-panel`) the retention table, and
 *                                 the project's own date — in orange from
 *                                 seven days before (`retention-warning`)
 *
 * The last two are folded under one line of the first row that sums them up
 * (`project-details-toggle`): the work comes first.
 *
 * The project comes from the page (ProjectContext). The primary
 * action "Continuer vers le contrat" is enabled as soon as the project has a
 * name. Everything is kept as it is typed (utils/projectStore → the server).
 */

import React, { useState } from "react";
import { Box, ButtonBase, Checkbox, Collapse, FormControlLabel, TextField, Typography, alpha, useMediaQuery, useTheme } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FingerprintIcon from "@mui/icons-material/Fingerprint";
import DocumentDrop from "../common/DocumentDrop";
import { deleteBriefDocument, uploadBriefDocument } from "../../utils/networkStudioApi";
import { useLanguage } from "../../contexts/LanguageContext";
import { useFeatures } from "../../utils/featuresApi";
import { formatDate, formatNumber } from "../../utils/formatDate";
import { announceDocument, useCurrentProject } from "../../utils/projectStore";
import { useAccount } from "../../contexts/AccountContext";
import StepFrame, { useFillLayout } from "./StepFrame";

export { documentStateOf } from "../common/DocumentDrop";


const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_WARNING_DAYS = 7;
// What ⑤ can produce (`deliverables_wanted`); the GTFS is always wanted.
export const DELIVERABLES = Object.freeze({ create: ["gtfs", "note", "coherence", "share"], modify: ["gtfs", "note", "coherence", "notice", "share"] });

/** The last version whose zip the project keeps (the one "Reprendre" restores), or null. */
export const frozenVersionOf = (project) =>
  [...(project?.versions || [])].filter((v) => v?.zip?.sha256 && !v.zip.purged_at).sort((a, b) => (b.n ?? 0) - (a.n ?? 0))[0] || null;

/** How long the server keeps a project: a year (or what it says) once it is an account's, else the browser's term. */
export const retentionDaysOf = (workspace, signedIn = false) => (signedIn && workspace?.account_retention_days ? workspace.account_retention_days : workspace?.retention_days ?? 30);

/** Days until a date (rounded up, never below 0), or null. */
const daysUntil = (iso, now = Date.now()) => {
  const at = Date.parse(iso || "");
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / DAY_MS)) : null;
};

function Panel({ title, testid, children, sx = {} }) {
  const theme = useTheme();
  return (
    <Box component="section" aria-label={title} data-testid={testid} sx={{ p: 1.25, borderRadius: "12px", border: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper, display: "flex", flexDirection: "column", gap: 0.5, minWidth: 0, ...sx }}>
      <Typography component="h2" sx={{ fontSize: "0.82rem", fontWeight: 800 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

/**
 * The project's documents, where the person drops them (①): what the project keeps, then the drop zone (DocumentDrop —
 * the brief and its annexes, dragged or picked), uploaded and announced from here (announceDocument → ProjectPage
 * keeps them with the project).
 */
function ProjectDocuments({ project, retentionDays = 30, sentToAssistant = false, sx = {} }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [uploads, setUploads] = useState([]); // being sent, or refused: { tempId, name, status, error? }
  const attach = (files) => {
    for (const file of files) {
      const tempId = `up-${Math.random().toString(36).slice(2, 10)}`;
      setUploads((u) => [...u, { tempId, name: file.name, status: "uploading" }]);
      uploadBriefDocument(file, { sentToAssistant })
        .then((d) => {
          setUploads((u) => u.filter((x) => x.tempId !== tempId));
          announceDocument("added", d);
        })
        .catch((err) => {
          const message = err?.code === "DOCUMENT_TOO_LARGE" ? t("network.docs.tooLarge") : err?.code === "UNSUPPORTED_DOCUMENT" ? t("network.docs.unsupported") : err?.message || t("network.docs.unsupported");
          setUploads((u) => u.map((x) => (x.tempId === tempId ? { ...x, status: "error", error: message } : x)));
        });
    }
  };
  const remove = (d) => {
    if (!d.id) {
      setUploads((u) => u.filter((x) => x.tempId !== d.tempId));
      return;
    }
    deleteBriefDocument(d.id);
    announceDocument("removed", d);
  };
  return (
    <Box component="section" aria-labelledby="step-network-documents" data-testid="documents-panel" sx={{ p: 1.25, borderRadius: "12px", border: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper, display: "flex", flexDirection: "column", gap: 0.75, minWidth: 0, ...sx }}>
      <Typography id="step-network-documents" component="h2" sx={{ fontSize: "0.82rem", fontWeight: 800 }}>
        {t("documents.section")}
      </Typography>
      <DocumentDrop
        title={false}
        pending={uploads}
        records={project?.documents || []}
        retentionDays={retentionDays}
        retentionUntil={project?.retention_until || null}
        onAttach={attach}
        onRemove={remove}
        testid="documents-drop"
        itemTestid="project-document"
      />
    </Box>
  );
}

/** What ⑤ will produce: ticked by the person, kept with the project (the validated GTFS is always there). */
export function DeliverablesWanted({ project, job, onChange, bare = false }) {
  const { t } = useLanguage();
  const wanted = new Set(Array.isArray(project?.deliverables_wanted) ? project.deliverables_wanted : ["gtfs"]);
  const toggle = (key) => {
    const next = new Set(wanted);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    next.add("gtfs");
    onChange?.(DELIVERABLES[job === "modify" ? "modify" : "create"].filter((k) => next.has(k)));
  };
  const boxes = (
      <Box data-testid={bare ? "deliverables-panel" : undefined} sx={{ display: "flex", flexWrap: "wrap", columnGap: 1, rowGap: 0 }}>
        {DELIVERABLES[job === "modify" ? "modify" : "create"].map((key) => (
          <FormControlLabel
            key={key}
            control={<Checkbox size="small" checked={key === "gtfs" || wanted.has(key)} disabled={key === "gtfs" || !onChange} onChange={() => toggle(key)} inputProps={{ "data-testid": `deliverable-${key}` }} sx={{ py: 0.25 }} />}
            label={<Typography sx={{ fontSize: "0.76rem" }}>{t(`delivery.${key}`, { n: "" })}</Typography>}
            sx={{ mr: 0.5 }}
          />
        ))}
      </Box>
  );
  return bare ? boxes : <Panel title={t("deliverables.wanted")} testid="deliverables-panel">{boxes}</Panel>;
}

/** The retention table, and this project's own date (in orange from seven days before). */
export function RetentionPanel({ project, workspace = null, bare = false }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const { signedIn } = useAccount();
  const days = retentionDaysOf(workspace, signedIn);
  const left = daysUntil(project?.retention_until);
  const soon = left !== null && left <= RETENTION_WARNING_DAYS;
  const maxVersions = workspace?.max_versions ?? 10;
  const maxMb = Math.round((workspace?.max_version_bytes ?? 200 * 1024 * 1024) / 1024 / 1024);
  const body = (
    <>
      {project?.retention_until && (
        <Typography data-testid={soon ? "retention-warning" : "retention-until"} sx={{ fontSize: "0.76rem", fontWeight: soon ? 800 : 600, color: soon ? "warning.dark" : "text.primary", ...(soon ? { p: 0.75, borderRadius: "8px", background: alpha(theme.palette.warning.main, 0.1) } : {}) }}>
          {t(soon ? "retention.soon" : "retention.until", { date: formatDate(project.retention_until, language), days: left })}
        </Typography>
      )}
      <Box component="ul" sx={{ m: 0, pl: 2.25, fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.5 }}>
        <li>{t("retention.project", { days })}</li>
        <li>{t("retention.documents")}</li>
        <li>{t("retention.versions", { max: maxVersions, mb: maxMb })}</li>
        <li>{t("retention.deliverables")}</li>
        <li>{t("retention.share")}</li>
        <li>{t("retention.workingCopy")}</li>
      </Box>
    </>
  );
  return bare ? <Box data-testid="retention-panel" sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>{body}</Box> : <Panel title={t("retention.title")} testid="retention-panel">{body}</Panel>;
}

/** The deliverables wanted and the retention summed up on one line, which unfolds them (`project-details-toggle`). */
function DetailsToggle({ project, open, onToggle, sx = {} }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const wanted = Array.isArray(project?.deliverables_wanted) ? project.deliverables_wanted : ["gtfs"];
  const left = daysUntil(project?.retention_until);
  const soon = left !== null && left <= RETENTION_WARNING_DAYS;
  const summary = [t("project.details.deliverables", { count: wanted.length }), project?.retention_until ? t("project.details.until", { date: formatDate(project.retention_until, language) }) : null].filter(Boolean).join(" · ");
  return (
    <ButtonBase onClick={onToggle} aria-expanded={open} aria-controls="step-network-project" data-testid="project-details-toggle" sx={{ justifyContent: "flex-start", gap: 0.75, px: 1.25, minHeight: 40, borderRadius: "10px", border: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper, textAlign: "left", minWidth: 0, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 }, ...sx }}>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography component="span" sx={{ display: "block", fontSize: "0.8rem", fontWeight: 800, lineHeight: 1.3 }}>
          {t("project.details.title")}
        </Typography>
        <Typography component="span" sx={{ display: "block", fontSize: "0.7rem", lineHeight: 1.3, color: soon ? "warning.dark" : "text.secondary", fontWeight: soon ? 700 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {summary}
        </Typography>
      </Box>
      <ExpandMoreIcon aria-hidden sx={{ fontSize: 18, transition: "transform 0.2s", transform: open ? "rotate(180deg)" : "none", color: "text.secondary" }} />
    </ButtonBase>
  );
}

/**
 * ① is a workspace, not a long page: the Network Studio's. Its first row holds the project's name and the line that
 * unfolds the deliverables and the retention; below it the workbench (the map, the lines, the stops, its documents
 * in its own column) takes the height left. `documents`: false when the flow shows them itself (the Network Studio's
 * column), else ① lists and uploads them.
 */
export default function StepNetwork({ name = "", onRename, workbench = null, documents, primary, footer = null, notice = null, headless = false }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const { features } = useFeatures();
  const fill = useFillLayout();
  // On a desktop screen, the workbench holds the name, the documents, the access and the retention itself (its
  // starting point and its inspector): ① is the workbench alone (on a phone, the workbench is the older one).
  const narrow = useMediaQuery(theme.breakpoints.down("md"), { noSsr: true });
  const benchOnly = Boolean(workbench) && !narrow;
  const { signedIn } = useAccount();
  const current = useCurrentProject();
  const project = current?.project || null;
  const update = current?.update || null;
  const frozen = frozenVersionOf(project);
  const workspace = features?.workspace || null;
  const left = daysUntil(project?.retention_until);
  // Unfolded by itself while the project's retention ends within seven days.
  const [detailsOpen, setDetailsOpen] = useState(() => left !== null && left <= RETENTION_WARNING_DAYS);
  const gap = 1.25;
  const docs = documents === false || !project ? null : <ProjectDocuments project={project} retentionDays={retentionDaysOf(workspace, signedIn)} sentToAssistant={Boolean(features?.chat?.enabled)} />;
  const fingerprint = frozen ? (
    // The fingerprint itself is the version's identity for the machine (data-fingerprint), not words for the reader.
    <Typography data-testid="network-fingerprint" data-fingerprint={frozen.zip.sha256} data-version={frozen.n} title={frozen.zip.sha256} sx={{ display: "flex", alignItems: "center", gap: 0.5, fontSize: "0.74rem", color: "text.secondary" }}>
      <FingerprintIcon aria-hidden sx={{ fontSize: 16 }} />
      {t("network.frozenShort", { n: frozen.n, size: formatNumber((frozen.zip.bytes || 0) / 1024 / 1024, language, { maximumFractionDigits: 1 }) })}
    </Typography>
  ) : null;
  return (
    <StepFrame step={1} job="create" intro={t("step.1.intro.create")} notice={notice} primary={primary} footer={footer} testid="step-network" headless={headless || benchOnly} bodySx={benchOnly && fill ? { overflowY: "hidden" } : {}}>
      {benchOnly ? (
        <Box sx={{ flex: 1, minHeight: fill ? 0 : "auto", display: "flex", flexDirection: "column" }}>{workbench}</Box>
      ) : (
        <>
          <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 1, pt: 0.75, mb: 1, flexShrink: 0 }}>
            <TextField
              size="small"
              label={t("network.project.name")}
              value={name}
              onChange={(e) => onRename?.(e.target.value.slice(0, 200))}
              inputProps={{ "data-testid": "project-name", maxLength: 200 }}
              sx={{ flex: "1 1 260px", maxWidth: 480 }}
            />
            {project && <DetailsToggle project={project} open={detailsOpen} onToggle={() => setDetailsOpen((v) => !v)} sx={{ flex: "1 1 280px" }} />}
          </Box>
          {project && (
            <Collapse in={detailsOpen} data-testid="step-network-details" sx={{ flexShrink: 0 }}>
              <Box id="step-network-project" data-testid="step-network-project" sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" }, gap: 1, mb: 1 }}>
                <DeliverablesWanted project={project} job="create" onChange={update ? (list) => update({ deliverables_wanted: list }) : null} />
                <RetentionPanel project={project} workspace={workspace} />
              </Box>
            </Collapse>
          )}
          {fingerprint && <Box sx={{ mb: 1, flexShrink: 0 }}>{fingerprint}</Box>}
          {/* The workbench takes the height left — never less than a usable map: below that, the body scrolls. */}
          <Box sx={{ flex: 1, minHeight: fill ? 420 : "auto", display: "flex", flexDirection: "column" }}>{workbench}</Box>
          {docs && <Box sx={{ mt: gap, flexShrink: 0 }}>{docs}</Box>}
        </>
      )}
    </StepFrame>
  );
}
