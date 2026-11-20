import React, { useMemo, useState } from "react";
import { Box, Collapse, Typography, alpha, useTheme } from "@mui/material";
import TaskAltIcon from "@mui/icons-material/TaskAlt";
import { useLanguage } from "../../contexts/LanguageContext";
import RuleOccurrenceTable from "./RuleOccurrenceTable";
import { Notice, NoticeAct } from "./Notice";

const MONOSPACE = '"JetBrains Mono", "Fira Code", monospace';

/**
 * The findings the tolerant import already settled (exact duplicate rows folded at load, the first kept): no work left,
 * but hiding them would misrepresent the validator's report, so one line says them, its files and counts, and opens
 * their rows on demand.
 */
function AutoFixedBanner({ findings }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const tone = theme.palette.success.main;

  // A sampled tail counts for what it stands for.
  const byFile = useMemo(() => {
    const map = new Map();
    let total = 0;
    for (const f of findings) {
      const weight = f.aggregate ? f.aggregateCount || 1 : 1;
      total += weight;
      map.set(f.fileName, (map.get(f.fileName) || 0) + weight);
    }
    return { entries: [...map.entries()], total };
  }, [findings]);

  return (
    <Box data-testid="auto-fixed-banner" sx={{ flexShrink: 0 }}>
      <Notice
        tone={tone}
        testId="auto-fixed-line"
        icon={<TaskAltIcon />}
        title={t("validation.autoFixed.body")}
        action={
          <NoticeAct onClick={() => setOpen((v) => !v)} testId="auto-fixed-toggle">
            {t(open ? "validation.autoFixed.hide" : "validation.autoFixed.show")}
          </NoticeAct>
        }
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
          <span>{t("validation.autoFixed.title", { count: byFile.total })}</span>
          {byFile.entries.map(([fileName, count]) => (
            <Box key={fileName} component="span" sx={{ fontFamily: MONOSPACE, fontSize: "0.72rem", fontWeight: 600, px: 0.75, py: 0.1, borderRadius: "6px", bgcolor: alpha(tone, 0.12), color: tone }}>
              {`${fileName} · ${count}`}
            </Box>
          ))}
        </Box>
      </Notice>
      {/* unmountOnExit: hundreds of settled rows are drawn only when asked for. */}
      <Collapse in={open} timeout={180} unmountOnExit>
        <Box sx={{ borderBottom: `1px solid ${theme.palette.divider}`, bgcolor: "background.paper" }}>
          <Typography sx={{ px: 3, pt: 1.25, pb: 0.5, fontSize: "0.8rem", color: "text.secondary", maxWidth: 860 }}>{t("validation.autoFixed.body")}</Typography>
          <Box sx={{ maxHeight: 260, display: "flex", flexDirection: "column" }}>
            <RuleOccurrenceTable occurrences={findings} ruleCode={findings[0]?.ruleCode || "duplicate_key"} />
          </Box>
        </Box>
      </Collapse>
    </Box>
  );
}

export default AutoFixedBanner;
