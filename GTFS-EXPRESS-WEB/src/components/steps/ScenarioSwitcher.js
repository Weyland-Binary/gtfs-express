/**
 * ScenarioSwitcher — the scenarios of the change step (target design §5
 * B3, the former ScenarioBar of the Change Studio): the plan being edited
 * (an unnamed draft or a named scenario, saved as it changes), switching to
 * another, saving the draft under a name, duplicating, renaming, deleting,
 * a scenario as a JSON file (export / import) and "Compare" — with the
 * scenario's state in words next to it (`scenario-state`: brouillon, or
 * "appliqué en vN (figé)" once applied, D37: a frozen scenario is read only,
 * and "Nouveau scénario sur vN" starts the next one).
 *
 * The plans are still kept per feed in this browser (utils/changeScenarios);
 * the project's scenarios move to the server with WP7.
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, TextField, Tooltip, Typography } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import BookmarkAddOutlinedIcon from "@mui/icons-material/BookmarkAddOutlined";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
import CompareOutlinedIcon from "@mui/icons-material/CompareOutlined";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import LayersOutlinedIcon from "@mui/icons-material/LayersOutlined";
import CheckIcon from "@mui/icons-material/Check";
import { useLanguage } from "../../contexts/LanguageContext";
import { QuietButton } from "../network/StudioUI";
import { activeScenario, isPlanEmpty } from "../../utils/changeScenarios";

const when = (iso, lang) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(`${String(lang || "en").slice(0, 2)}-u-nu-latn`, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
};

/** A small dialog asking for a name. */
function NameDialog({ open, title, initial, onCancel, onConfirm }) {
  const { t } = useLanguage();
  const [name, setName] = useState(initial || "");
  useEffect(() => {
    if (open) setName(initial || "");
  }, [open, initial]);
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth data-testid="change-scenario-name-dialog">
      <DialogTitle sx={{ fontWeight: 800 }}>{title}</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          size="small"
          label={t("transform.scenario.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) onConfirm(name.trim());
          }}
          inputProps={{ maxLength: 80, "data-testid": "change-scenario-name" }}
          sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} sx={{ textTransform: "none" }}>
          {t("app.cancel")}
        </Button>
        <Button variant="contained" disableElevation disabled={!name.trim()} onClick={() => onConfirm(name.trim())} data-testid="change-scenario-name-ok" sx={{ textTransform: "none", fontWeight: 700 }}>
          {t("transform.scenario.ok")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** `compact`: icons for the actions and the saved time in the switch's tooltip (the Network Studio's plan column). */
export default function ScenarioSwitcher({ ws, disabled = false, onSwitch, onSaveAs, onDuplicate, onRename, onDelete, onExport, onImport, onCompare, suggestedName = "", appliedIn = null, compact = false }) {
  const { t, language } = useLanguage();
  const [listAnchor, setListAnchor] = useState(null);
  const [moreAnchor, setMoreAnchor] = useState(null);
  const [naming, setNaming] = useState(null); // { mode: "save" | "duplicate" | "rename", initial }
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef(null);
  if (!ws) return null;
  const active = activeScenario(ws);
  const draftEmpty = isPlanEmpty(ws.draft?.plan);
  const comparable = ws.scenarios.filter((s) => !isPlanEmpty(s.plan)).length + (draftEmpty ? 0 : 1);
  const activeName = active ? active.name : t("transform.scenario.draft");
  const updated = active ? active.updated_at : ws.draft?.updated_at;
  const closeMenus = () => {
    setListAnchor(null);
    setMoreAnchor(null);
  };
  const confirmName = (name) => {
    const mode = naming?.mode;
    setNaming(null);
    if (mode === "save") onSaveAs(name);
    else if (mode === "duplicate") onDuplicate(name);
    else if (mode === "rename" && active) onRename(active.id, name);
  };
  return (
    <Box data-testid="scenario-switcher" data-frozen={appliedIn ? "true" : "false"} sx={{ minWidth: 0 }}>
      <Box data-testid="change-scenario-bar" sx={{ display: "flex", alignItems: "center", gap: 0.5, minWidth: 0, flexWrap: compact ? "nowrap" : "wrap" }}>
        <LayersOutlinedIcon sx={{ fontSize: 16, color: "text.secondary" }} />
        <Button size="small" disabled={disabled} onClick={(e) => setListAnchor(e.currentTarget)} endIcon={<ExpandMoreIcon />} title={compact && updated ? t("transform.scenario.saved", { date: when(updated, language) }) : undefined} data-testid="change-scenario-switch" sx={{ textTransform: "none", fontWeight: 700, fontSize: "0.78rem", color: "text.primary", minWidth: 0, maxWidth: compact ? 200 : 260, px: 0.75 }}>
          <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} data-testid="change-scenario-active">
            {activeName}
          </Box>
        </Button>
        <Typography component="span" data-testid="scenario-state" className={compact && !appliedIn ? "visually-hidden" : undefined} sx={{ fontSize: "0.7rem", fontWeight: 700, color: appliedIn ? "success.main" : "text.secondary", whiteSpace: "nowrap" }}>
          ({appliedIn ? t("scenario.state.applied", { n: appliedIn }) : t("scenario.state.draft")})
        </Typography>
        {updated && !compact && (
          <Typography sx={{ fontSize: "0.68rem", color: "text.disabled", whiteSpace: "nowrap" }} data-testid="change-scenario-saved">
            {t("transform.scenario.saved", { date: when(updated, language) })}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        {!active &&
          (compact ? (
            <Tooltip title={t("transform.scenario.saveAs")}>
              <span>
                <IconButton size="small" disabled={disabled || draftEmpty} onClick={() => setNaming({ mode: "save", initial: suggestedName })} aria-label={t("transform.scenario.saveAs")} data-testid="change-scenario-save">
                  <BookmarkAddOutlinedIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </span>
            </Tooltip>
          ) : (
            <QuietButton startIcon={<BookmarkAddOutlinedIcon sx={{ fontSize: 16 }} />} disabled={disabled || draftEmpty} onClick={() => setNaming({ mode: "save", initial: suggestedName })} data-testid="change-scenario-save">
              {t("transform.scenario.saveAs")}
            </QuietButton>
          ))}
        <Tooltip title={comparable < 2 ? t("transform.scenario.compareHint") : compact ? t("transform.scenario.compare") : ""}>
          <span>
            {compact ? (
              <IconButton size="small" disabled={disabled || comparable < 2} onClick={onCompare} aria-label={t("transform.scenario.compare")} data-testid="change-scenario-compare">
                <CompareOutlinedIcon sx={{ fontSize: 18 }} />
              </IconButton>
            ) : (
              <QuietButton startIcon={<CompareOutlinedIcon sx={{ fontSize: 16 }} />} disabled={disabled || comparable < 2} onClick={onCompare} data-testid="change-scenario-compare">
                {t("transform.scenario.compare")}
              </QuietButton>
            )}
          </span>
        </Tooltip>
        <Tooltip title={t("transform.scenario.more")}>
          <span>
            <IconButton size="small" disabled={disabled} onClick={(e) => setMoreAnchor(e.currentTarget)} aria-label={t("transform.scenario.more")} data-testid="change-scenario-more">
              <MoreHorizIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </span>
        </Tooltip>

        <Menu anchorEl={listAnchor} open={Boolean(listAnchor)} onClose={closeMenus} data-testid="change-scenario-list">
          <MenuItem
            selected={!active}
            onClick={() => {
              closeMenus();
              onSwitch(null);
            }}
            data-testid="change-scenario-item-draft"
          >
            <ListItemIcon>{!active && <CheckIcon fontSize="small" />}</ListItemIcon>
            <ListItemText primary={t("transform.scenario.draft")} secondary={draftEmpty ? t("transform.scenario.empty") : t("transform.scenario.steps", { count: ws.draft.plan.operations.length })} />
          </MenuItem>
          {ws.scenarios.map((s) => (
            <MenuItem
              key={s.id}
              selected={active?.id === s.id}
              onClick={() => {
                closeMenus();
                onSwitch(s.id);
              }}
              data-testid="change-scenario-item"
            >
              <ListItemIcon>{active?.id === s.id && <CheckIcon fontSize="small" />}</ListItemIcon>
              <ListItemText primary={s.name} secondary={[t("transform.scenario.steps", { count: s.plan.operations.length }), s.applied_at ? t("transform.scenario.applied", { date: when(s.applied_at, language) }) : when(s.updated_at, language)].filter(Boolean).join(" · ")} />
            </MenuItem>
          ))}
        </Menu>

        <Menu anchorEl={moreAnchor} open={Boolean(moreAnchor)} onClose={closeMenus}>
          {active && (
            <MenuItem
              onClick={() => {
                closeMenus();
                setNaming({ mode: "duplicate", initial: t("transform.scenario.copyOf", { name: active.name }) });
              }}
              data-testid="change-scenario-duplicate"
            >
              <ListItemIcon>
                <ContentCopyOutlinedIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary={t("transform.scenario.duplicate")} />
            </MenuItem>
          )}
          {active && (
            <MenuItem
              onClick={() => {
                closeMenus();
                setNaming({ mode: "rename", initial: active.name });
              }}
              data-testid="change-scenario-rename"
            >
              <ListItemIcon>
                <DriveFileRenameOutlineIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary={t("transform.scenario.rename")} />
            </MenuItem>
          )}
          {active && (
            <MenuItem
              onClick={() => {
                closeMenus();
                setConfirmDelete(true);
              }}
              data-testid="change-scenario-delete"
            >
              <ListItemIcon>
                <DeleteOutlineIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary={t("transform.scenario.delete")} />
            </MenuItem>
          )}
          {active && <Divider />}
          <MenuItem
            disabled={!active && draftEmpty}
            onClick={() => {
              closeMenus();
              onExport();
            }}
            data-testid="change-scenario-export"
          >
            <ListItemIcon>
              <FileDownloadOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t("transform.scenario.export")} />
          </MenuItem>
          <MenuItem
            onClick={() => {
              closeMenus();
              fileRef.current?.click();
            }}
            data-testid="change-scenario-import"
          >
            <ListItemIcon>
              <FileUploadOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t("transform.scenario.import")} />
          </MenuItem>
        </Menu>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept=".json,application/json"
          data-testid="change-scenario-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) onImport(f);
          }}
        />

        <NameDialog open={Boolean(naming)} title={naming?.mode === "rename" ? t("transform.scenario.rename") : naming?.mode === "duplicate" ? t("transform.scenario.duplicate") : t("transform.scenario.saveAs")} initial={naming?.initial} onCancel={() => setNaming(null)} onConfirm={confirmName} />
        <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} maxWidth="xs" fullWidth data-testid="change-scenario-delete-dialog">
          <DialogTitle sx={{ fontWeight: 800 }}>{t("transform.scenario.deleteTitle")}</DialogTitle>
          <DialogContent>
            <Typography sx={{ fontSize: "0.84rem" }}>{t("transform.scenario.deleteConfirm", { name: active?.name || "" })}</Typography>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirmDelete(false)} sx={{ textTransform: "none" }}>
              {t("app.cancel")}
            </Button>
            <Button
              color="error"
              variant="contained"
              disableElevation
              onClick={() => {
                setConfirmDelete(false);
                if (active) onDelete(active.id);
              }}
              data-testid="change-scenario-delete-ok"
              sx={{ textTransform: "none", fontWeight: 700 }}
            >
              {t("transform.scenario.delete")}
            </Button>
          </DialogActions>
        </Dialog>
      </Box>
    </Box>
  );
}
