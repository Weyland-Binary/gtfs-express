import React from "react";
import { Box, CircularProgress, useTheme } from "@mui/material";
import UpdateRoundedIcon from "@mui/icons-material/UpdateRounded";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import ReportGmailerrorredRoundedIcon from "@mui/icons-material/ReportGmailerrorredRounded";
import TaskAltIcon from "@mui/icons-material/TaskAlt";
import { useLanguage } from "../../contexts/LanguageContext";
import { countWords } from "../../utils/countWords";
import AutoFixedBanner from "./AutoFixedBanner";
import { Notice, NoticeAct } from "./Notice";

/**
 * What the report must say before its findings, one line each: a report older than the last edits, rows the import
 * kept aside, checks the validator could not run, findings the import already settled.
 */
export default function ReportNotices({ stale = false, checking = false, onRevalidate, asideTotal = 0, onShowAside = null, incomplete = null, crashedChecks = [], autoFixedFindings = [], importAdjustmentsTotal = 0 }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const warning = theme.palette.severities.warning.main;
  const info = theme.palette.severities.info.main;
  return (
    <>
      {stale && (
        <Notice
          tone={info}
          testId="validation-stale-banner"
          icon={checking ? <CircularProgress size={15} thickness={5} color="inherit" /> : <UpdateRoundedIcon />}
          action={!checking && onRevalidate ? <NoticeAct onClick={onRevalidate} testId="validation-stale-revalidate">{t("validation.revalidate.button")}</NoticeAct> : null}
        >
          {checking ? t("validation.stale.checking") : t("validation.stale.banner")}
        </Notice>
      )}
      {asideTotal > 0 && (
        <Notice
          tone={warning}
          testId="validation-aside-banner"
          icon={<Inventory2OutlinedIcon />}
          action={onShowAside ? <NoticeAct onClick={onShowAside} testId="validation-aside-show">{t("validation.aside.show")}</NoticeAct> : null}
        >
          {countWords(t, "validation.aside.banner", asideTotal, { count: asideTotal })}
        </Notice>
      )}
      {incomplete && (
        <Notice tone={warning} testId="validation-incomplete-banner" icon={<ReportGmailerrorredRoundedIcon />}>
          <strong>{t("validation.incomplete.title")}</strong> {t("validation.incomplete.body", { n: incomplete.total || 1 })}
          {crashedChecks.length > 0 && (
            <Box component="span" sx={{ display: "block", color: "text.secondary", fontSize: "0.75rem" }}>
              {t("validation.incomplete.checks", { checks: crashedChecks.join(", ") })}
            </Box>
          )}
        </Notice>
      )}
      {autoFixedFindings.length > 0 ? (
        <AutoFixedBanner findings={autoFixedFindings} />
      ) : importAdjustmentsTotal > 0 ? (
        <Notice tone={theme.palette.success.main} testId="validation-import-adjusted" icon={<TaskAltIcon />}>
          {t("validation.autoFixed.persist", { count: importAdjustmentsTotal })}
        </Notice>
      ) : null}
    </>
  );
}
