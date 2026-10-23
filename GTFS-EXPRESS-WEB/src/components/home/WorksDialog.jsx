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
  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="sm" aria-labelledby="home-projects-title" data-testid="works-dialog" PaperProps={{ sx: { borderRadius: "20px", overflow: "hidden", display: "flex", flexDirection: "column" } }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, px: 2.5, pt: 2, pb: 1.5 }}>
        <Box aria-hidden sx={{ width: 34, height: 34, borderRadius: "10px", display: "grid", placeItems: "center", color: "primary.main", backgroundColor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.18 : 0.1) }}>
          <WorkHistoryOutlinedIcon sx={{ fontSize: 19 }} />
        </Box>
        <Typography id="home-projects-title" component="h2" sx={{ flex: 1, fontSize: "1.1rem", fontWeight: 750, letterSpacing: "-0.01em" }}>
          {t("home.projects")}
          {projects.length > 0 && (
            <Box component="span" data-testid="works-count" sx={{ ml: 1, px: 0.9, py: 0.15, borderRadius: 999, fontSize: "0.74rem", fontWeight: 700, color: "text.secondary", backgroundColor: alpha(theme.palette.text.primary, 0.07), verticalAlign: "middle" }}>
              {projects.length}
            </Box>
          )}
        </Typography>
        <Tooltip title={t("app.close")}>
          <IconButton onClick={close} aria-label={t("app.close")} data-testid="works-close" sx={{ mr: -1, color: "text.secondary", transition: "transform .18s", "&:hover": { transform: "rotate(90deg)" }, "@media (prefers-reduced-motion: reduce)": { transition: "none", "&:hover": { transform: "none" } } }}>
            <CloseRoundedIcon />
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
        <Box data-testid="works-empty" sx={{ px: 3, pt: 2, pb: 4, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 1.25 }}>
          <Box aria-hidden sx={{ width: 56, height: 56, borderRadius: "16px", display: "grid", placeItems: "center", color: "text.disabled", backgroundColor: alpha(theme.palette.text.primary, 0.05) }}>
            <WorkHistoryOutlinedIcon sx={{ fontSize: 28 }} />
          </Box>
          <Typography sx={{ fontSize: "0.9rem", color: "text.secondary", maxWidth: 360, lineHeight: 1.5 }}>{t("works.empty")}</Typography>
        </Box>
      )}
    </Dialog>
  );
}
