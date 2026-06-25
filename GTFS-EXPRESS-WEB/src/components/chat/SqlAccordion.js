/**
 * SqlAccordion — Collapsed-by-default SQL block inside an assistant bubble.
 *
 * UX:
 *  - Header is a slim row with verb chip + char count + copy + expand icon.
 *  - Body is a scrollable mono-font block with inline keyword highlighting
 *    (reuses `highlightSqlInline` from the SQL Console for consistency).
 *  - Copy button gives instant feedback (icon swap + tooltip) without
 *    using a snackbar (chat is busy enough already).
 */

import React, { useMemo, useState } from "react";
import {
  Box,
  Chip,
  IconButton,
  Tooltip,
  Collapse,
  alpha,
  useTheme,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import CodeIcon from "@mui/icons-material/Code";
import { useLanguage } from "../../contexts/LanguageContext";
import { MONO_FONT } from "../SqlConsole/constants";
import {
  highlightSqlInline,
  SQL_KEYWORD_HL_RE,
} from "../SqlConsole/sqlText";

const detectVerb = (sql) => {
  if (!sql) return "";
  const m = sql.trim().match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : "";
};

export default function SqlAccordion({ sql, defaultExpanded = false, dense = false }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [justCopied, setJustCopied] = useState(false);

  const verb = useMemo(() => detectVerb(sql), [sql]);
  const parts = useMemo(() => {
    // Reset lastIndex (regex is shared & sticky-ish via /g flag in the helper).
    SQL_KEYWORD_HL_RE.lastIndex = 0;
    return highlightSqlInline(sql || "");
  }, [sql]);

  const copy = (e) => {
    e.stopPropagation();
    if (!sql) return;
    try {
      navigator.clipboard.writeText(sql);
      setJustCopied(true);
      setTimeout(() => setJustCopied(false), 1400);
    } catch {
      /* clipboard blocked */
    }
  };

  if (!sql) return null;

  const verbColor =
    verb === "SELECT" || verb === "WITH" || verb === "EXPLAIN"
      ? theme.palette.info.main
      : theme.palette.warning.main;

  const containerBg = alpha(theme.palette.text.primary, 0.04);
  const headerBg = alpha(theme.palette.text.primary, 0.06);

  return (
    <Box
      sx={{
        mt: dense ? 0.75 : 1,
        borderRadius: 1.5,
        overflow: "hidden",
        border: `1px solid ${alpha(theme.palette.text.primary, 0.10)}`,
        background: containerBg,
      }}
    >
      <Box
        onClick={() => setExpanded((v) => !v)}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1.25,
          py: 0.65,
          cursor: "pointer",
          background: headerBg,
          "&:hover": {
            background: alpha(theme.palette.text.primary, 0.08),
          },
          transition: "background 120ms",
        }}
      >
        <CodeIcon sx={{ fontSize: 14, color: "text.secondary", flexShrink: 0 }} />
        <Chip
          label={verb || "SQL"}
          size="small"
          sx={{
            height: 18,
            fontSize: "0.62rem",
            fontWeight: 700,
            letterSpacing: 0.4,
            color: "#fff",
            bgcolor: verbColor,
            "& .MuiChip-label": { px: 0.85 },
          }}
        />
        <Box
          sx={{
            ml: 0.5,
            fontSize: "0.68rem",
            color: "text.disabled",
            fontFamily: MONO_FONT,
            flex: 1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {expanded ? `${sql.length} chars` : sql.split("\n")[0].slice(0, 80)}
        </Box>
        <Tooltip title={justCopied ? t("chat.sql.copied") : t("chat.sql.copy")}>
          <IconButton
            size="small"
            onClick={copy}
            sx={{ width: 22, height: 22 }}
          >
            {justCopied ? (
              <CheckIcon sx={{ fontSize: 13, color: "success.main" }} />
            ) : (
              <ContentCopyIcon sx={{ fontSize: 13 }} />
            )}
          </IconButton>
        </Tooltip>
        <ExpandMoreIcon
          sx={{
            fontSize: 16,
            color: "text.secondary",
            transition: "transform 160ms",
            transform: expanded ? "rotate(180deg)" : "none",
          }}
        />
      </Box>
      <Collapse in={expanded} unmountOnExit>
        <Box
          sx={{
            px: 1.5,
            py: 1.1,
            maxHeight: 220,
            overflow: "auto",
            fontFamily: MONO_FONT,
            fontSize: "0.74rem",
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {parts ? (
            parts.map((p, i) =>
              p.kind === "kw" ? (
                <Box
                  key={i}
                  component="span"
                  sx={{
                    color: theme.palette.primary.main,
                    fontWeight: 700,
                  }}
                >
                  {p.value}
                </Box>
              ) : (
                <span key={i}>{p.value}</span>
              ),
            )
          ) : (
            <span>{sql}</span>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}
