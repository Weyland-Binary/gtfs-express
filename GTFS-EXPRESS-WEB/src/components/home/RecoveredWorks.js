/**
 * RecoveredWorks — « Travaux récupérés sur cet ordinateur » on Home (target
 * design §9: the emergency recovery, `projectAutoSave.js` kept as the local
 * safety net).
 *
 * The browser saves the working copy being edited as a working file in
 * IndexedDB (utils/projectAutoSave) while the tab is open; after a crash or
 * a closed tab those copies are listed here, most recent first, each with
 * when it was saved and its size, to reopen (through the explorer card's
 * one opener, the `gtfs:open-working-file` event: same beta gate, same
 * guard) or to delete. Nothing is listed when there is nothing to recover.
 * Since the workspace keeps the projects and their versions on the server,
 * this is the net under the net, not the place where the work lives.
 */

import React, { useEffect, useState } from "react";
import { Box, IconButton, Tooltip, Typography, useTheme } from "@mui/material";
import HistoryOutlinedIcon from "@mui/icons-material/HistoryOutlined";
import RestoreIcon from "@mui/icons-material/Restore";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { useLanguage } from "../../contexts/LanguageContext";
import { deleteSnapshot, getSnapshotBlob, listSnapshots } from "../../utils/projectAutoSave";
import { PROJECT_EXT } from "../../utils/projectFile";
import { formatDateTime } from "../../utils/formatDate";
import { OPEN_WORKING_FILE_EVENT } from "../GTFSUploader";
import { sizeLabel } from "../steps/StepDelivery";

/** A size in the interface's language and its unit ("1,2 Mo", "1.2 MB"), or nothing. */
const sizeOf = (bytes, language, t) => (bytes > 0 ? sizeLabel(bytes, language, t) : "");

export default function RecoveredWorks() {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const [snapshots, setSnapshots] = useState([]);
  const [error, setError] = useState(null);

  const refresh = async () => {
    try {
      setSnapshots(await listSnapshots());
    } catch {
      setSnapshots([]);
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const restore = async (snap) => {
    setError(null);
    const blob = await getSnapshotBlob(snap.id).catch(() => null);
    if (!blob) {
      setError(t("project.snapshotMissing"));
      return;
    }
    // IndexedDB keeps a Blob: a File gives the server the working file's name.
    const name = `${(snap.meta && snap.meta.source_feed_name) || "project"}${PROJECT_EXT}`;
    window.dispatchEvent(new CustomEvent(OPEN_WORKING_FILE_EVENT, { detail: { file: new File([blob], name, { type: "application/octet-stream", lastModified: snap.ts || Date.now() }) } }));
  };
  const remove = async (id) => {
    if (!window.confirm(t("uploader.recentProjects.confirmDelete"))) return;
    await deleteSnapshot(id);
    refresh();
  };

  if (!snapshots.length) return null;
  return (
    <Box component="section" aria-labelledby="home-recovered-title" data-testid="home-recovered" sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
      <Typography id="home-recovered-title" component="h2" sx={{ display: "flex", alignItems: "center", gap: 0.75, fontSize: "0.9rem", fontWeight: 800 }}>
        <HistoryOutlinedIcon aria-hidden sx={{ fontSize: 18, color: "text.secondary" }} />
        {t("home.recovered", { count: snapshots.length })}
      </Typography>
      <Typography sx={{ fontSize: "0.74rem", color: "text.secondary" }}>{t("uploader.recentProjects.desc")}</Typography>
      {error && <Typography sx={{ fontSize: "0.76rem", color: "error.main" }}>{error}</Typography>}
      <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.5 }}>
        {snapshots.map((snap) => {
          const name = (snap.meta && snap.meta.source_feed_name) || t("project.untitled");
          return (
            <Box component="li" key={snap.id} data-testid="home-recovered-row" sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.25, py: 0.75, borderRadius: "10px", border: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontSize: "0.82rem", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={name}>
                  {name}
                </Typography>
                <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }}>{[formatDateTime(snap.ts, language), sizeOf(snap.size, language, t)].filter(Boolean).join(" · ")}</Typography>
              </Box>
              <Tooltip title={t("buttons.restore")}>
                <IconButton size="small" onClick={() => restore(snap)} aria-label={`${t("buttons.restore")} — ${name}`}>
                  <RestoreIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title={t("buttons.delete")}>
                <IconButton size="small" onClick={() => remove(snap.id)} aria-label={`${t("buttons.delete")} — ${name}`}>
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
