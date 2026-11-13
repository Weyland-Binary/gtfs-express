// « Ce réseau a déjà un projet »: asked by « Modifier » when this browser already works on the files open here.

import React, { useEffect, useRef, useState } from "react";
import { Box, Button, ButtonBase, Dialog, DialogActions, DialogContent, Typography, alpha, useTheme } from "@mui/material";
import WorkHistoryOutlinedIcon from "@mui/icons-material/WorkHistoryOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import DialogHeader from "../common/DialogHeader";
import { projectStateText, whenText } from "../home/ProjectList";
import { answerKnownProject, useKnownProjectQuestion } from "../../utils/knownProject";

export default function KnownProjectDialog() {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const question = useKnownProjectQuestion();
  const known = question?.known || [];
  // A project open in another tab is said so and not resumed here: that would take it from there.
  const firstFree = known.findIndex((k) => !k.elsewhere);
  const [chosen, setChosen] = useState(firstFree);
  const rowsRef = useRef([]);
  useEffect(() => setChosen(firstFree), [question, firstFree]);
  const project = known[chosen] && !known[chosen].elsewhere ? known[chosen].project : null;
  const resume = (p = project) => p && answerKnownProject({ resume: p });
  const close = () => answerKnownProject(null);
  const several = known.length > 1;

  // The arrows move the choice among the projects that can be resumed, the focus with it.
  const onKeyDown = (e) => {
    if (!several || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    for (let i = chosen + step; i >= 0 && i < known.length; i += step) {
      if (known[i].elsewhere) continue;
      setChosen(i);
      rowsRef.current[i]?.focus();
      return;
    }
  };

  return (
    <Dialog open={Boolean(question)} onClose={close} fullWidth maxWidth="xs" aria-labelledby="known-project-title" data-testid="known-project-dialog">
      <DialogHeader icon={<WorkHistoryOutlinedIcon />} title={t("knownProject.title")} subtitle={known[0]?.project.network?.name || null} titleId="known-project-title" onClose={close} closeTestId="known-project-close" />
      <DialogContent>
        <Box role={several ? "radiogroup" : undefined} aria-label={several ? t("knownProject.title") : undefined} onKeyDown={onKeyDown} sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
          {known.map(({ project: p, n, elsewhere }, i) => {
            const on = several && i === chosen;
            const facts = [projectStateText(p, t), n > 0 ? t("knownProject.version", { n }) : null, whenText(p.updated_at, language)].filter(Boolean).join(" · ");
            const body = (
              <Box sx={{ minWidth: 0 }}>
                <Typography noWrap sx={{ fontSize: "0.9rem", fontWeight: 650 }}>{p.name || p.network?.name || ""}</Typography>
                <Typography noWrap sx={{ fontSize: "0.78rem", color: "text.secondary" }}>{facts}</Typography>
                {elsewhere ? <Typography sx={{ fontSize: "0.78rem", fontWeight: 600, color: "warning.main", mt: 0.25 }}>{t("knownProject.elsewhere")}</Typography> : null}
              </Box>
            );
            const frame = { textAlign: "left", px: 1.5, py: 1.1, borderRadius: "10px", border: `1px solid ${on ? theme.palette.primary.main : theme.palette.divider}`, backgroundColor: on ? alpha(theme.palette.primary.main, 0.06) : "transparent" };
            if (!several) {
              return (
                <Box key={p.id} data-testid="known-project-row" data-project={p.id} data-elsewhere={elsewhere ? "true" : undefined} sx={frame}>
                  {body}
                </Box>
              );
            }
            return (
              <ButtonBase
                key={p.id}
                ref={(el) => (rowsRef.current[i] = el)}
                role="radio"
                aria-checked={on}
                aria-disabled={elsewhere || undefined}
                disabled={elsewhere}
                tabIndex={on || (chosen < 0 && i === 0) ? 0 : -1}
                data-testid="known-project-row"
                data-project={p.id}
                data-elsewhere={elsewhere ? "true" : undefined}
                onClick={() => setChosen(i)}
                onDoubleClick={() => resume(p)}
                sx={{ ...frame, justifyContent: "flex-start", opacity: elsewhere ? 0.75 : 1 }}
              >
                {body}
              </ButtonBase>
            );
          })}
        </Box>
      </DialogContent>
      <DialogActions>
        {project ? (
          <>
            <Button color="inherit" onClick={() => answerKnownProject({ fresh: true })} data-testid="known-project-fresh">
              {t("knownProject.fresh")}
            </Button>
            <Button variant="contained" disableElevation autoFocus onClick={() => resume()} data-testid="known-project-resume">
              {t("knownProject.resume")}
            </Button>
          </>
        ) : (
          <Button variant="contained" disableElevation autoFocus onClick={() => answerKnownProject({ fresh: true })} data-testid="known-project-fresh">
            {t("knownProject.fresh")}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
