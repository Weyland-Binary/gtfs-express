import React from "react";
import { Box, CircularProgress, useTheme } from "@mui/material";
import UpdateRoundedIcon from "@mui/icons-material/UpdateRounded";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import ReportGmailerrorredRoundedIcon from "@mui/icons-material/ReportGmailerrorredRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import TaskAltIcon from "@mui/icons-material/TaskAlt";
import TranslateRoundedIcon from "@mui/icons-material/TranslateRounded";
import ContentCutRoundedIcon from "@mui/icons-material/ContentCutRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { countWords } from "../../utils/countWords";
import { encodingFallbacksOf } from "../../utils/importNotes";
import { getSessionId } from "../../utils/sessionManager";
import AutoFixedBanner from "./AutoFixedBanner";
import { Notice, NoticeAct } from "./Notice";

/**
 * What the report must say before its findings, one line each: a report older than the last edits, rows the import
 * kept aside, checks the validator could not run, a report its second pass completed (`secondPass`, the report's
 * `second_pass`: the values set aside, the rows left out), findings the import already settled, rows it loaded without their empty
 * cells past the header (`importSettled`, the report's `import_settled`), files it read as Windows-1252.
 */
export default function ReportNotices({ stale = false, checking = false, onRevalidate, asideTotal = 0, onShowAside = null, incomplete = null, crashedChecks = [], secondPass = null, importSettled = null, autoFixedFindings = [], importAdjustmentsTotal = 0 }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const warning = theme.palette.severities.warning.main;
  const info = theme.palette.severities.info.main;
  const reread = encodingFallbacksOf(getSessionId());
  const trimmedFiles = Object.entries(importSettled?.trailing_cells || {}).filter(([, n]) => Number(n) > 0);
  const trimmedRows = trimmedFiles.reduce((sum, [, n]) => sum + Number(n), 0);
  // Checks skipped for files the validator could not read name those files; checks that crashed name themselves.
  const unreadFiles = Array.isArray(incomplete?.files) ? incomplete.files : null;
  const blanked = Number(secondPass?.blanked) || 0;
  const rowsLeftOut = Number(secondPass?.rows_left_out) || 0;
  const emptyFiles = Array.isArray(secondPass?.omitted) ? secondPass.omitted : [];
  const setAside = [blanked > 0 ? countWords(t, "validation.secondPass", blanked) : null, rowsLeftOut > 0 ? countWords(t, "validation.secondPass.rows", rowsLeftOut) : null].filter(Boolean);
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
        <Notice tone={warning} testId="validation-incomplete-banner" icon={<ReportGmailerrorredRoundedIcon />} title={unreadFiles && Array.isArray(incomplete.validators) && incomplete.validators.length ? incomplete.validators.join(", ") : undefined}>
          <strong>{t("validation.incomplete.title")}</strong>{" "}
          {unreadFiles ? t("validation.incomplete.unread", { files: unreadFiles.join(", "), n: incomplete.total || 1 }) : t("validation.incomplete.body", { n: incomplete.total || 1 })}
          {!unreadFiles && crashedChecks.length > 0 && (
            <Box component="span" sx={{ display: "block", color: "text.secondary", fontSize: "0.75rem" }}>
              {t("validation.incomplete.checks", { checks: crashedChecks.join(", ") })}
            </Box>
          )}
        </Notice>
      )}
      {secondPass && !incomplete && (setAside.length > 0 || emptyFiles.length > 0) && (
        <Notice tone={info} testId="validation-second-pass" icon={<ReplayRoundedIcon />}>
          {setAside.length > 0 ? setAside.join(" ") : t("validation.secondPass.empty", { files: emptyFiles.join(", ") })}
        </Notice>
      )}
      {autoFixedFindings.length > 0 ? (
        <AutoFixedBanner findings={autoFixedFindings} />
      ) : importAdjustmentsTotal > 0 ? (
        <Notice tone={theme.palette.success.main} testId="validation-import-adjusted" icon={<TaskAltIcon />}>
          {t("validation.autoFixed.persist", { count: importAdjustmentsTotal })}
        </Notice>
      ) : null}
      {trimmedRows > 0 && (
        <Notice tone={info} testId="validation-import-settled" icon={<ContentCutRoundedIcon />}>
          {countWords(t, "validation.importSettled.trailingCells", trimmedRows, { count: trimmedRows, files: trimmedFiles.map(([file]) => file).join(", ") })}
        </Notice>
      )}
      {reread.length > 0 && (
        <Notice tone={info} testId="validation-encoding-notice" icon={<TranslateRoundedIcon />}>
          {countWords(t, "validation.encoding.windows1252", reread.length, { files: reread.map((f) => f.fileName).join(", ") })}
        </Notice>
      )}
    </>
  );
}
