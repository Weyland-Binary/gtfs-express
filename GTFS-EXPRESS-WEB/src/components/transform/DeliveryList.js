/**
 * DeliveryList — the documents the draft's decision delivers besides the GTFS (its own first button in the decision):
 * the note and the coherence report, each with its download, and the service-méthode files of the report.
 */

import React from "react";
import { Box, Button, CircularProgress, Typography } from "@mui/material";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { CoherenceDownloadNotice, CoherenceFileButtons, CoherenceRunning } from "../common/CoherenceReport";

export function DeliveryList({ downloads, onNote, noteDisabled = false, onCsv, csvDisabled = false, fileSource = null, fileLabels = {} }) {
  const { t } = useLanguage();
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
      <Box component="ul" data-testid="delivery-list" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 0.75 }}>
        <Box component="li" data-testid="delivery-note" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1 }}>
          <Typography sx={{ flex: 1, minWidth: 200, fontSize: "0.82rem", fontWeight: 700 }}>{t("delivery.note")}</Typography>
          <CoherenceRunning downloads={downloads} id="note" />
          <Button size="small" variant="outlined" startIcon={downloads.running === "note" ? <CircularProgress size={12} color="inherit" /> : <DescriptionOutlinedIcon />} onClick={onNote} disabled={noteDisabled} data-testid="delivery-note-download" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("delivery.download")}
          </Button>
        </Box>
        <Box component="li" data-testid="delivery-coherence" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1 }}>
          <Typography sx={{ flex: 1, minWidth: 200, fontSize: "0.82rem", fontWeight: 700 }}>{t("delivery.coherence")}</Typography>
          <CoherenceRunning downloads={downloads} id="csv" />
          <Button size="small" variant="outlined" startIcon={downloads.running === "csv" ? <CircularProgress size={12} color="inherit" /> : <FileDownloadOutlinedIcon />} onClick={onCsv} disabled={csvDisabled} data-testid="delivery-coherence-csv" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("coherence.csv")}
          </Button>
          <CoherenceFileButtons source={fileSource} labels={fileLabels} />
        </Box>
      </Box>
      <CoherenceDownloadNotice downloads={downloads} />
    </Box>
  );
}
