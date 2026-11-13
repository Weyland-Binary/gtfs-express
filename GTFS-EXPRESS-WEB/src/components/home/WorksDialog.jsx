// « Mes travaux » in a dialog over any page, opened by WORKS_OPEN_EVENT (the account menu, refusals that lead there).

import React, { useEffect, useState } from "react";
import { Box, Dialog, Typography, alpha, useTheme } from "@mui/material";
import WorkHistoryOutlinedIcon from "@mui/icons-material/WorkHistoryOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useProjects } from "../../utils/projectStore";
import { isEmptyWork } from "../../utils/workState";
import ProjectList from "./ProjectList";
import DialogHeader from "../common/DialogHeader";
import { WORKS_OPEN_EVENT } from "../../utils/appEvents";

export default function WorksDialog({ onOpenProject }) {
  const { t } = useLanguage();
  const theme = useTheme();
  // A work holding nothing is not one: opened and left as it was, it is not listed.
  const all = useProjects();
  const projects = all.filter((p) => !isEmptyWork(p, t));
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(WORKS_OPEN_EVENT, show);
    return () => window.removeEventListener(WORKS_OPEN_EVENT, show);
  }, []);
  const close = () => setOpen(false);
  return (
    <Dialog
      open={open}
      onClose={close}
      fullWidth
      maxWidth="md"
      aria-labelledby="home-projects-title"
      data-testid="works-dialog"
      PaperProps={{ sx: { overflow: "hidden", display: "flex", flexDirection: "column" } }}
    >
      <DialogHeader
        icon={<WorkHistoryOutlinedIcon />}
        title={
          <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
            {t("home.projects")}
            {projects.length > 0 && (
              <Box component="span" data-testid="works-count" sx={{ px: 0.75, minWidth: 22, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 999, fontSize: 12, fontWeight: 700, color: "text.secondary", backgroundColor: alpha(theme.palette.text.primary, 0.07) }}>
                {projects.length}
              </Box>
            )}
          </Box>
        }
        onClose={close}
        closeTestId="works-close"
      />
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
