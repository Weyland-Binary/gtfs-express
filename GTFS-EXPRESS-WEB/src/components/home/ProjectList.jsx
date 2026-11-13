/**
 * « Mes travaux »: the projects of this browser or of the account, grouped by network, the last written first, a work
 * holding nothing never listed. A work is one row of a list: its way's icon (by hand, with a brief, an aggregate), its
 * name, what it holds as a coloured dot and words, when it was last written; its acts, « Reprendre » (or « Ouvrir » once
 * delivered) and delete confirmed in place, show under the pointer or the keyboard's focus, the row itself opening it.
 * The retention shows on a row only in its last seven days, otherwise in its tooltip. A project the server refused to
 * keep (quota, size) says so on its row with « Réessayer ».
 */

import React, { useMemo, useState } from "react";
import { Box, Button, ButtonBase, IconButton, InputAdornment, TextField, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import AltRouteOutlinedIcon from "@mui/icons-material/AltRouteOutlined";
import LayersOutlinedIcon from "@mui/icons-material/LayersOutlined";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import SearchIcon from "@mui/icons-material/Search";
import HubOutlinedIcon from "@mui/icons-material/HubOutlined";
import DeleteSweepOutlinedIcon from "@mui/icons-material/DeleteSweepOutlined";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { formatDate, formatDateTime } from "../../utils/formatDate";
import { activeScenarioOf, latestVersionOf, removeProject, retryLocal, useProjectSync } from "../../utils/projectStore";
import { draftKindOf, draftOperationsOf } from "../../utils/changeStates";
import { isEmptyWork, workStateOf, workStateWords } from "../../utils/workState";
import { kindToneOf } from "../transform/draftKinds";
import { refusalToAction } from "../../utils/refusalToAction";

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_WARNING_DAYS = 7;
// A search shows from this many works on.
const SEARCH_FROM = 6;

export const daysLeft = (project, now = Date.now()) => {
  const until = Date.parse(project?.retention_until || "");
  return Number.isFinite(until) ? Math.max(0, Math.ceil((until - now) / DAY_MS)) : null;
};

/** A row's words: [job, its draft or its version, last written]. */
export const projectLine = (project, t, language) => {
  const job = t("flow.modify.title");
  const draft = draftOperationsOf(project);
  const version = latestVersionOf(project);
  const scenario = activeScenarioOf(project);
  // A delivered version first, then a draft with changes, then the latest version kept.
  const state = project.delivery?.version_id
    ? t("version.delivered", { n: (project.versions || []).find((v) => v.id === project.delivery.version_id)?.n ?? version?.n ?? 1 })
    : draft > 0
      ? t(draft === 1 ? "work.draft.one" : "work.draft.many", { count: draft })
      : version && version.kind !== "reference"
        ? t(version.kind === "applied" ? "version.applied" : version.kind === "snapshot" ? "home.project.snapshot" : version.kind === "delivered" ? "version.delivered" : "home.project.snapshot", {
            n: version.n,
          })
        : scenario
          ? t("home.project.scenario", { name: scenario.name })
          : null;
  return [job, state, formatDateTime(project.updated_at, language)].filter(Boolean);
};

/** What a project holds now, in the reader's words: its draft, its version, delivered, or nothing changed yet. */
export const projectStateText = (project, t) => {
  if (project.delivery?.version_id) {
    const n = (project.versions || []).find((v) => v.id === project.delivery.version_id)?.n ?? latestVersionOf(project)?.n ?? 1;
    return t("version.delivered", { n });
  }
  const state = workStateOf({ project });
  if (!state || state.kind === "source") return t("works.state.none");
  return workStateWords(state, t)?.label || t("works.state.none");
};

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether a project still has the name it was given: « Modification — <network> » in any language, or none. */
export const hasDefaultName = (project, t) => {
  const name = String(project?.name ?? "").trim();
  if (!name || name === t("step.defaultName.modifyNone")) return true;
  const net = project?.network?.name;
  return Boolean(net) && new RegExp(`^[^—]{1,32} — ${escapeRe(net)}( \\(\\d+\\))?$`).test(name);
};

/** « il y a 5 min », « hier », then the date: when the work was last written. */
export const whenText = (iso, language, now = Date.now()) => {
  const at = Date.parse(iso || "");
  if (!Number.isFinite(at)) return "";
  const s = Math.round((at - now) / 1000);
  const abs = Math.abs(s);
  try {
    const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
    if (abs < 60) return rtf.format(0, "second");
    if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
    if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
    if (abs < 6 * 86400) return rtf.format(Math.round(s / 86400), "day");
  } catch {
    /* an engine without RelativeTimeFormat: the date */
  }
  return formatDateTime(iso, language);
};

/** The state a work is filtered by: in progress (a draft, or nothing changed yet), applied or published, delivered. */
export const projectStage = (project) => {
  if (project.delivery?.version_id) return "delivered";
  const state = workStateOf({ project });
  if (state?.kind === "aggregate") return state.published ? "applied" : "progress";
  return state && (state.kind === "applied" || state.kind === "version") ? "applied" : "progress";
};

function NotKept({ project }) {
  const { t } = useLanguage();
  const sync = useProjectSync(project.id);
  if (sync?.state !== "local" || !sync.error) return null;
  const view = refusalToAction({ code: sync.refusal?.code || sync.error, status: sync.refusal?.status ?? null, message: "", details: sync.refusal?.details || {} }, t);
  return (
    <Box data-testid="project-not-kept" data-code={view.code || "default"} sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 0.75, mt: 0.5 }}>
      <Typography sx={{ fontSize: "0.74rem", color: "warning.dark", fontWeight: 700 }}>
        {t("home.project.notKept")} : {view.body}
      </Typography>
      <Button size="small" variant="outlined" color="warning" onClick={() => retryLocal(project.id)} data-testid="project-retry" sx={{ textTransform: "none", fontWeight: 700, py: 0, minHeight: 26, borderRadius: "8px" }}>
        {t("refusal.default.action")}
      </Button>
    </Box>
  );
}

/** Deletes the project and its versions here and on the server, confirmed in place. */
function DeleteAction({ project, onDelete, onAsking }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [asking, setAsking] = useState(false);
  const name = project.name || t("home.project.untitled");
  const ask = (on) => {
    setAsking(on);
    onAsking?.(on);
  };
  if (!asking) {
    return (
      <Tooltip title={t("home.project.delete")}>
        <IconButton
          size="small"
          onClick={() => ask(true)}
          data-testid="project-delete"
          aria-label={`${t("home.project.delete")} : ${name}`}
          sx={{ width: 32, height: 32, flexShrink: 0, borderRadius: "8px", color: "text.secondary", "&:hover": { color: "error.main", backgroundColor: alpha(theme.palette.error.main, 0.08) } }}
        >
          <DeleteOutlineIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
    );
  }
  return (
    <Box role="group" aria-label={t("home.project.deleteConfirm", { name })} data-testid="project-delete-ask" sx={{ display: "flex", alignItems: "center", gap: 0.75, flexShrink: 0 }}>
      <Typography sx={{ fontSize: "0.8rem", fontWeight: 650, color: "error.main", whiteSpace: "nowrap" }}>{t("home.project.deleteShort")}</Typography>
      <Button size="small" variant="outlined" color="inherit" autoFocus onClick={() => ask(false)} data-testid="project-delete-cancel" sx={{ textTransform: "none", fontWeight: 700, borderRadius: "10px", borderColor: theme.palette.divider }}>
        {t("home.project.deleteCancel")}
      </Button>
      <Button size="small" color="error" variant="contained" disableElevation onClick={() => onDelete?.(project)} data-testid="project-delete-confirm" sx={{ textTransform: "none", fontWeight: 750, borderRadius: "10px" }}>
        {t("home.project.delete")}
      </Button>
    </Box>
  );
}

const wayOf = (project, theme) => {
  if (project.job === "aggregate") return { icon: LayersOutlinedIcon, tone: kindToneOf(theme, "aggregate"), word: "home.project.kind.aggregate" };
  const kind = draftKindOf(project);
  if (kind === "hand") return { icon: EditOutlinedIcon, tone: kindToneOf(theme, "hand"), word: "draft.kind.hand.short" };
  if (kind === "brief") return { icon: DescriptionOutlinedIcon, tone: kindToneOf(theme, "brief"), word: "draft.kind.brief.short" };
  return { icon: AltRouteOutlinedIcon, tone: theme.palette.text.secondary, word: "home.project.kind.modify" };
};

// A stage's colour: a draft under way, a version applied or published, a version delivered.
const stageToneOf = (theme, stage) => (stage === "delivered" ? theme.palette.primary : stage === "applied" ? theme.palette.success : theme.palette.warning);

function Row({ project, onOpen, onDelete, now }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const [asking, setAsking] = useState(false);
  const left = daysLeft(project, now);
  const soon = left !== null && left <= RETENTION_WARNING_DAYS;
  const delivered = Boolean(project.delivery);
  const way = wayOf(project, theme);
  const Icon = way.icon;
  const named = !hasDefaultName(project, t);
  const retention = left !== null ? t(soon ? "home.project.retentionSoon" : "home.project.retention", { date: formatDate(project.retention_until, language), days: left }) : null;
  const action = t(delivered ? "home.open" : "home.resume");
  const name = project.name || t("home.project.untitled");
  const stage = stageToneOf(theme, projectStage(project));
  const dark = theme.palette.mode === "dark";
  // The row opens the work like its button; its buttons and the delete's confirmation keep their own clicks.
  const openFromRow = (e) => {
    if (asking || e.target.closest("button, a, input, [role=group]")) return;
    onOpen?.(project);
  };
  return (
    <Box
      component="li"
      data-testid="project-row"
      data-project-id={project.id}
      data-job={project.job}
      title={retention && !soon ? retention : undefined}
      onClick={openFromRow}
      sx={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        px: 1.25,
        py: 1,
        borderRadius: "10px",
        cursor: asking ? "default" : "pointer",
        transition: "background-color 120ms",
        "& + &": { boxShadow: `0 -1px 0 ${theme.palette.divider}` },
        "&:hover, &:focus-within": { backgroundColor: alpha(theme.palette.primary.main, dark ? 0.1 : 0.05), boxShadow: "none" },
        "&:hover + &, &:focus-within + &": { boxShadow: "none" },
        // The acts wait under the pointer or the focus: a list reads as names, not as buttons.
        "& .project-acts": { opacity: asking ? 1 : 0, transition: "opacity 120ms" },
        "&:hover .project-acts, &:focus-within .project-acts": { opacity: 1 },
        "@media (hover: none)": { "& .project-acts": { opacity: 1 } },
        "@media (prefers-reduced-motion: reduce)": { transition: "none", "& .project-acts": { transition: "none" } },
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, minWidth: 0, minHeight: 40 }}>
        <Icon aria-hidden sx={{ fontSize: 19, color: way.tone, flexShrink: 0 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: "0.9rem", fontWeight: 650, lineHeight: 1.35, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={named ? project.name : undefined}>
            {named ? project.name : t(way.word)}
          </Typography>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mt: 0.15, minWidth: 0, fontSize: "0.78rem", color: "text.secondary", whiteSpace: "nowrap", overflow: "hidden" }}>
            <Box component="span" data-testid="project-state" sx={{ display: "inline-flex", alignItems: "center", gap: 0.6, minWidth: 0, fontWeight: 600, color: dark ? stage.light : stage.dark }}>
              <Box component="span" aria-hidden sx={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, backgroundColor: stage.main }} />
              <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {projectStateText(project, t)}
              </Box>
            </Box>
            {named && (
              <>
                <span aria-hidden>·</span>
                <Box component="span" sx={{ flexShrink: 0 }}>
                  {t(way.word)}
                </Box>
              </>
            )}
            <span aria-hidden>·</span>
            <Box component="span" sx={{ flexShrink: 0 }} title={formatDateTime(project.updated_at, language)}>
              {whenText(project.updated_at, language, now)}
            </Box>
          </Box>
        </Box>
        <Box className="project-acts" sx={{ display: "flex", alignItems: "center", gap: 0.5, flexShrink: 0 }}>
          {!asking && (
            <Button
              variant="text"
              size="small"
              endIcon={<ArrowForwardRoundedIcon sx={{ fontSize: "16px !important" }} />}
              onClick={() => onOpen?.(project)}
              data-testid="project-resume"
              aria-label={`${action} : ${name}`}
              sx={{ textTransform: "none", fontWeight: 700, fontSize: "0.82rem", borderRadius: "8px", px: 1.25, height: 32, whiteSpace: "nowrap" }}
            >
              {action}
            </Button>
          )}
          <DeleteAction project={project} onDelete={onDelete} onAsking={setAsking} />
        </Box>
      </Box>
      {retention && soon && (
        <Typography data-testid="project-retention" data-soon="true" sx={{ fontSize: "0.74rem", color: "warning.dark", fontWeight: 700, mt: 0.25, pl: 4 }}>
          {retention}
        </Typography>
      )}
      <Box sx={{ pl: 4, "&:empty": { display: "none" } }}>
        <NotKept project={project} />
      </Box>
    </Box>
  );
}

const STAGES = ["all", "progress", "applied", "delivered"];
// A network shows its latest works; the others wait behind « Afficher les n autres ».
const GROUP_SHOWN = 3;

/** Deletes every work shown (all of them, or those the filter and the search keep), confirmed in place. */
function DeleteAll({ items, filtered, onDelete }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [asking, setAsking] = useState(false);
  if (!items.length) return null;
  const label = filtered ? t("works.deleteShown", { count: items.length }) : t("works.deleteAll");
  if (!asking) {
    return (
      <Button size="small" variant="outlined" color="inherit" startIcon={<DeleteSweepOutlinedIcon />} onClick={() => setAsking(true)} data-testid="works-delete-all" sx={{ textTransform: "none", fontWeight: 650, borderRadius: "10px", color: "text.secondary", borderColor: theme.palette.divider, "&:hover": { color: "error.main", borderColor: alpha(theme.palette.error.main, 0.5), backgroundColor: alpha(theme.palette.error.main, 0.05) } }}>
        {label}
      </Button>
    );
  }
  return (
    <Box role="group" aria-label={t("works.deleteAllConfirm", { count: items.length })} data-testid="works-delete-all-ask" sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
      <Typography sx={{ fontSize: "0.82rem", fontWeight: 650, color: "error.main" }}>{t("works.deleteAllConfirm", { count: items.length })}</Typography>
      <Button size="small" variant="outlined" color="inherit" autoFocus onClick={() => setAsking(false)} data-testid="works-delete-all-cancel" sx={{ textTransform: "none", fontWeight: 700, borderRadius: "10px", borderColor: theme.palette.divider }}>
        {t("home.project.deleteCancel")}
      </Button>
      <Button
        size="small"
        color="error"
        variant="contained"
        disableElevation
        onClick={() => {
          setAsking(false);
          for (const p of items) onDelete?.(p);
        }}
        data-testid="works-delete-all-confirm"
        sx={{ textTransform: "none", fontWeight: 750, borderRadius: "10px" }}
      >
        {label}
      </Button>
    </Box>
  );
}

// `bare`: inside a dialog (WorksDialog), the header given by the dialog, the bulk delete at its foot.
export default function ProjectList({ projects: all = [], onOpen, onDelete = (p) => removeProject(p.id), now = Date.now(), bare = false }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const projects = useMemo(() => all.filter((p) => !isEmptyWork(p, t)), [all, t]);
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("all");
  const [opened, setOpened] = useState(() => new Set());
  const counts = useMemo(() => {
    const out = { all: projects.length, progress: 0, applied: 0, delivered: 0 };
    for (const p of projects) out[projectStage(p)] += 1;
    return out;
  }, [projects]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((p) => (stage === "all" || projectStage(p) === stage) && (!q || `${p.name || ""} ${p.network?.name || ""}`.toLowerCase().includes(q)));
  }, [projects, query, stage]);
  // One group a network, in the order of its latest work.
  const groups = useMemo(() => {
    const out = new Map();
    for (const p of shown) {
      // One group a network as the person names it: its works across tabs and publications together.
      const key = String(p.network?.name || "").trim().toLowerCase() || p.network?.network_id || "";
      if (!out.has(key)) out.set(key, { key, name: p.network?.name || "", items: [] });
      out.get(key).items.push(p);
    }
    return [...out.values()];
  }, [shown]);
  if (!projects.length) return null;
  const long = projects.length >= SEARCH_FROM;
  const filtered = Boolean(query.trim()) || stage !== "all";
  // A search shows every match: nothing then waits behind « Afficher ».
  const openAll = Boolean(query.trim());
  const listBg = "transparent";
  return (
    <Box
      component="section"
      aria-labelledby="home-projects-title"
      data-testid="home-projects"
      sx={{
        color: "text.primary",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        ...(bare ? {} : { borderRadius: "16px", backgroundColor: theme.palette.background.paper, boxShadow: `0 12px 32px ${alpha(theme.palette.common.black, 0.18)}`, overflow: "hidden" }),
      }}
    >
      {!bare && (
        <Typography id="home-projects-title" component="h2" sx={{ px: 2.25, pt: 1.75, pb: 1, fontSize: "1rem", fontWeight: 700 }}>
          {t("home.projects")}{" "}
          <Box component="span" sx={{ color: "text.secondary", fontWeight: 500 }}>
            ({projects.length})
          </Box>
        </Typography>
      )}
      {long && (
        <Box sx={{ px: 2.5, pb: 1.5, display: "flex", alignItems: "center", gap: 1.25, flexWrap: "wrap" }}>
          <TextField
            size="small"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("works.search")}
            inputProps={{ "aria-label": t("works.search"), "data-testid": "works-search" }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
              sx: { borderRadius: "10px" },
            }}
            sx={{ flex: "1 1 220px", minWidth: 180 }}
          />
          <Box role="radiogroup" aria-label={t("works.filter")} data-testid="works-filter" sx={{ display: "inline-flex", p: 0.4, gap: 0.25, borderRadius: "11px", backgroundColor: alpha(theme.palette.text.primary, 0.06) }}>
            {STAGES.filter((k) => k === "all" || counts[k] > 0).map((k) => {
              const on = stage === k;
              return (
                <ButtonBase
                  key={k}
                  role="radio"
                  aria-checked={on}
                  onClick={() => setStage(k)}
                  data-testid={`works-filter-${k}`}
                  sx={{ px: 1.25, height: 30, borderRadius: "8px", fontSize: "0.8rem", fontWeight: on ? 700 : 550, gap: 0.6, color: on ? "text.primary" : "text.secondary", backgroundColor: on ? theme.palette.background.paper : "transparent", boxShadow: on ? `0 1px 3px ${alpha(theme.palette.common.black, 0.15)}` : "none", transition: "background-color 120ms, color 120ms", "&:hover": on ? {} : { color: "text.primary" }, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 1 } }}
                >
                  {t(`works.stage.${k}`)}
                  <Box component="span" sx={{ fontSize: "0.72rem", fontWeight: 700, color: "text.secondary" }}>
                    {counts[k]}
                  </Box>
                </ButtonBase>
              );
            })}
          </Box>
        </Box>
      )}
      <Box data-testid="home-projects-list" sx={{ flex: 1, minHeight: 0, maxHeight: bare ? "min(60vh, 600px)" : 4 * 76, overflowY: "auto", px: bare ? 2.5 : 1.25, py: 1.5, backgroundColor: listBg, borderTop: bare ? `1px solid ${theme.palette.divider}` : "none" }}>
        {groups.map((g) => {
          const all = openAll || opened.has(g.key) || g.items.length <= GROUP_SHOWN + 1;
          const items = all ? g.items : g.items.slice(0, GROUP_SHOWN);
          return (
            <Box key={g.key || "none"} component="section" aria-label={g.name || t("works.noNetwork")} data-testid="works-group" sx={{ "& + &": { mt: 2.25 } }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, px: 0.5, pb: 1 }}>
                <HubOutlinedIcon aria-hidden sx={{ fontSize: 16, color: "text.secondary" }} />
                <Typography component="h3" sx={{ fontSize: "0.8rem", fontWeight: 700, color: "text.primary", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {g.name || t("works.noNetwork")}
                </Typography>
                <Typography component="span" sx={{ px: 0.75, borderRadius: 999, fontSize: "0.7rem", color: "text.secondary", fontWeight: 700, backgroundColor: alpha(theme.palette.text.primary, 0.07) }}>
                  {g.items.length}
                </Typography>
              </Box>
              <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column" }}>
                {items.map((p) => (
                  <Row key={p.id} project={p} onOpen={onOpen} onDelete={onDelete} now={now} />
                ))}
              </Box>
              {!all && (
                <Button
                  size="small"
                  variant="outlined"
                  color="inherit"
                  onClick={() => setOpened((o) => new Set([...o, g.key]))}
                  endIcon={<ExpandMoreRoundedIcon />}
                  data-testid="works-group-more"
                  sx={{ mt: 1, textTransform: "none", fontWeight: 650, borderRadius: "10px", color: "text.secondary", borderColor: theme.palette.divider }}
                >
                  {t("works.showMore", { count: g.items.length - GROUP_SHOWN })}
                </Button>
              )}
            </Box>
          );
        })}
        {!shown.length && (
          <Typography data-testid="works-none" sx={{ px: 0.5, py: 3, fontSize: "0.88rem", color: "text.secondary", textAlign: "center" }}>
            {t("works.noMatch")}
          </Typography>
        )}
      </Box>
      {bare && (
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, px: 2.5, py: 1.25, borderTop: `1px solid ${theme.palette.divider}`, minHeight: 56 }}>
          <DeleteAll items={shown} filtered={filtered} onDelete={onDelete} />
          {filtered && (
            <Typography sx={{ fontSize: "0.78rem", color: "text.secondary", ml: "auto" }}>
              {t("works.shownOf", { shown: shown.length, total: projects.length })}
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
}
