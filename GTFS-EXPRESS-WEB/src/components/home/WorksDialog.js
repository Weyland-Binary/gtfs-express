/**
 * WorksDialog — « Mes travaux » in a window over any page: the projects of the account (or of this browser), each
 * to resume or to delete (ProjectList). Opened by the account menu and by every refusal whose way out is the
 * person's works (`openWorks`, utils/works); a project resumed closes it.
 */

import React, { useEffect, useState } from "react";
import { Box, Button, Dialog, Typography } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { useProjects } from "../../utils/projectStore";
import { WORKS_OPEN_EVENT } from "../../utils/works";
import ProjectList from "./ProjectList";

export default function WorksDialog({ onOpenProject }) {
  const { t } = useLanguage();
  const projects = useProjects();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(WORKS_OPEN_EVENT, show);
    return () => window.removeEventListener(WORKS_OPEN_EVENT, show);
  }, []);
  return (
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md" data-testid="works-dialog" PaperProps={{ sx: { borderRadius: "18px", overflow: "hidden" } }}>
      {projects.length ? (
        <ProjectList
          projects={projects}
          bare
          onOpen={(p) => {
            setOpen(false);
            onOpenProject?.(p);
          }}
        />
      ) : (
        <Box sx={{ p: 3 }}>
          <Typography sx={{ fontSize: "1rem", fontWeight: 700, mb: 0.5 }}>{t("home.projects")}</Typography>
          <Typography data-testid="works-empty" sx={{ fontSize: "0.88rem", color: "text.secondary" }}>
            {t("works.empty")}
          </Typography>
        </Box>
      )}
      <Box sx={{ display: "flex", justifyContent: "flex-end", px: 2, py: 1.25, borderTop: (th) => `1px solid ${th.palette.divider}` }}>
        <Button onClick={() => setOpen(false)} data-testid="works-close" sx={{ textTransform: "none", fontWeight: 650 }}>
          {t("app.close")}
        </Button>
      </Box>
    </Dialog>
  );
}
