// « Mes travaux » in a dialog over any page, opened by WORKS_OPEN_EVENT (the account menu, refusals that lead there).

import React, { useEffect, useState } from "react";
import { Box, Dialog, IconButton, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import WorkHistoryOutlinedIcon from "@mui/icons-material/WorkHistoryOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useProjects } from "../../utils/projectStore";
import ProjectList from "./ProjectList";
import { WORKS_OPEN_EVENT } from "../../utils/appEvents";

export default function WorksDialog({ onOpenProject }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const projects = useProjects();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(WORKS_OPEN_EVENT, show);
    return () => window.removeEventListener(WORKS_OPEN_EVENT, show);
  }, []);
  const close = () => setOpen(false);
  const dark = theme.palette.mode === "dark";
  return (
    <Dialog
      open={open}
      onClose={close}
      fullWidth
      maxWidth="md"
      aria-labelledby="home-projects-title"
      data-testid="works-dialog"
      PaperProps={{ sx: { maxWidth: 760, borderRadius: "20px", overflow: "hidden", display: "flex", flexDirection: "column", backgroundImage: "none" } }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2.5, pt: 2.25, pb: 2 }}>
        <Box aria-hidden sx={{ width: 40, height: 40, borderRadius: "12px", display: "grid", placeItems: "center", color: "primary.main", backgroundColor: alpha(theme.palette.primary.main, dark ? 0.2 : 0.1) }}>
          <WorkHistoryOutlinedIcon sx={{ fontSize: 21 }} />
        </Box>
        <Typography id="home-projects-title" component="h2" sx={{ flex: 1, display: "flex", alignItems: "center", gap: 1, fontSize: "1.2rem", fontWeight: 750, letterSpacing: "-0.015em" }}>
          {t("home.projects")}
          {projects.length > 0 && (
            <Box component="span" data-testid="works-count" sx={{ px: 1, py: "1px", borderRadius: 999, fontSize: "0.78rem", fontWeight: 700, color: "text.secondary", backgroundColor: alpha(theme.palette.text.primary, 0.07) }}>
              {projects.length}
            </Box>
          )}
        </Typography>
        <Tooltip title={t("app.close")}>
          <IconButton onClick={close} aria-label={t("app.close")} data-testid="works-close" sx={{ width: 36, height: 36, borderRadius: "10px", color: "text.secondary", border: `1px solid ${theme.palette.divider}`, "&:hover": { color: "text.primary", backgroundColor: alpha(theme.palette.text.primary, 0.05) } }}>
            <CloseRoundedIcon sx={{ fontSize: 20 }} />
          </IconButton>
        </Tooltip>
      </Box>
      {projects.length ? (
        <ProjectList
          projects={projects}
          bare
          onOpen={(p) => {
            close();
            onOpenProject?.(p);
          }}
        />
      ) : (
        <Box data-testid="works-empty" sx={{ px: 3, pt: 3, pb: 5, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 1.5, borderTop: `1px solid ${theme.palette.divider}` }}>
          <Box aria-hidden sx={{ width: 60, height: 60, borderRadius: "18px", display: "grid", placeItems: "center", color: "text.secondary", backgroundColor: alpha(theme.palette.text.primary, 0.06) }}>
            <WorkHistoryOutlinedIcon sx={{ fontSize: 30 }} />
          </Box>
          <Typography sx={{ fontSize: "0.92rem", color: "text.secondary", maxWidth: 380, lineHeight: 1.55 }}>{t("works.empty")}</Typography>
        </Box>
      )}
    </Dialog>
  );
}
