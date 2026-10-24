import React from "react";
import {
  Box,
  Button,
  Typography,
  IconButton,
  Tooltip,
  Divider,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  CircularProgress,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import DownloadIcon from "@mui/icons-material/Download";
import ClearIcon from "@mui/icons-material/Clear";
import SchemaIcon from "@mui/icons-material/Schema";
import HistoryIcon from "@mui/icons-material/History";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import FormatAlignLeftIcon from "@mui/icons-material/FormatAlignLeft";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DataObjectIcon from "@mui/icons-material/DataObject";
import TableViewIcon from "@mui/icons-material/TableView";
import IntegrationInstructionsIcon from "@mui/icons-material/IntegrationInstructions";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { MONO_FONT } from "./constants";
import { formatRelative } from "./formatters";
import Kbd from "./Kbd";

/**
 * The editor's action row: Run and Format, then the secondary actions. The assistant's button shows only when the
 * server enables nl2sql, since it would otherwise answer 503.
 */
export default function ConsoleToolbar({
  running,
  query,
  runQuery,
  handleFormat,
  nl2sqlEnabled,
  nl2sqlTriggerRef,
  nl2sqlAnchor,
  setNl2sqlAnchor,
  history,
  setHistoryAnchor,
  schemaVisible,
  setSchemaVisible,
  setSavePresetName,
  setSavePresetOpen,
  handleClearAll,
  result,
  exportCSV,
  t,
}) {
  const theme = useTheme();
  return (
    <>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          mt: 0.75,
          mb: 0.5,
          flexWrap: "wrap",
          minHeight: 32,
        }}
      >
        <Button
          variant="contained"
          color="primary"
          onClick={runQuery}
          disabled={running || !query.trim()}
          data-testid="sql-run"
          startIcon={
            running ? (
              <CircularProgress size={14} color="inherit" />
            ) : (
              <PlayArrowIcon />
            )
          }
          sx={{
            height: 32,
            px: 1.5,
            fontWeight: 700,
            letterSpacing: "0.02em",
            textTransform: "none",
            boxShadow: "none",
            animation: running
              ? "sqlPulseRun 1.2s ease-in-out infinite"
              : "none",
            "&:hover": { boxShadow: "none" },
          }}
        >
          {running ? t("sqlConsole.running") : t("sqlConsole.run")}
          <Kbd
            sx={{
              ml: 1,
              background: (th) =>
                alpha(th.palette.primary.contrastText, 0.18),
              border: (th) =>
                `1px solid ${alpha(th.palette.primary.contrastText, 0.25)}`,
              color: (th) => alpha(th.palette.primary.contrastText, 0.85),
            }}
          >
            ⌘↵
          </Kbd>
        </Button>
        <Tooltip title={t("sqlConsole.format")} arrow>
          <span>
            <Button
              variant="outlined"
              size="small"
              onClick={handleFormat}
              disabled={!query.trim()}
              startIcon={<FormatAlignLeftIcon fontSize="small" />}
              sx={{
                height: 32,
                textTransform: "none",
                borderColor: alpha(theme.palette.text.primary, 0.12),
                color: theme.palette.text.primary,
                "&:hover": {
                  borderColor: alpha(theme.palette.text.primary, 0.22),
                  background: alpha(theme.palette.text.primary, 0.04),
                },
              }}
            >
              {t("sqlConsole.format")}
            </Button>
          </span>
        </Tooltip>
        <Divider
          orientation="vertical"
          flexItem
          sx={{
            mx: 0.5,
            my: 0.5,
            borderColor: theme.palette.divider,
          }}
        />
        {nl2sqlEnabled && (
          <>
            <Tooltip title={t("nl2sql.title")} arrow>
              <IconButton
                size="small"
                ref={nl2sqlTriggerRef}
                onClick={(e) => {
                  setNl2sqlAnchor(nl2sqlAnchor ? null : e.currentTarget);
                }}
                aria-label={t("nl2sql.title")}
                aria-pressed={Boolean(nl2sqlAnchor)}
                sx={{
                  width: 32,
                  height: 32,
                  color: nl2sqlAnchor ? "#fff" : "#C9A84C",
                  background: nl2sqlAnchor
                    ? "#C9A84C"
                    : alpha("#C9A84C", 0.1),
                  border: `1px solid ${alpha("#C9A84C", 0.35)}`,
                  borderRadius: "6px",
                  transition:
                    "background-color 150ms ease, color 150ms ease, border-color 150ms ease",
                  "&:hover": {
                    background: nl2sqlAnchor
                      ? alpha("#C9A84C", 0.85)
                      : alpha("#C9A84C", 0.2),
                    borderColor: alpha("#C9A84C", 0.55),
                  },
                }}
              >
                <AutoAwesomeIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Divider
              orientation="vertical"
              flexItem
              sx={{
                mx: 0.5,
                my: 0.5,
                borderColor: theme.palette.divider,
              }}
            />
          </>
        )}
        <Tooltip
          title={
            <Box sx={{ display: "inline-flex", alignItems: "center" }}>
              {t("sqlConsole.history")}
            </Box>
          }
          arrow
        >
          <span>
            <IconButton
              size="small"
              onClick={(e) => setHistoryAnchor(e.currentTarget)}
              disabled={history.length === 0}
              aria-label={t("sqlConsole.history")}
              sx={{ width: 32, height: 32 }}
            >
              <HistoryIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip
          title={
            <Box sx={{ display: "inline-flex", alignItems: "center" }}>
              {t("sqlConsole.schema.toggle")}
              <Kbd>⌘\</Kbd>
            </Box>
          }
          arrow
        >
          <span>
            <IconButton
              size="small"
              onClick={() => setSchemaVisible((v) => !v)}
              aria-label={t("sqlConsole.schema.toggle")}
              aria-pressed={schemaVisible}
              sx={{
                width: 32,
                height: 32,
                background: schemaVisible
                  ? alpha(theme.palette.primary.main, 0.12)
                  : "transparent",
                color: schemaVisible
                  ? theme.palette.primary.main
                  : theme.palette.text.secondary,
                transition: "background-color 150ms ease, color 150ms ease",
                "&:hover": {
                  background: schemaVisible
                    ? alpha(theme.palette.primary.main, 0.18)
                    : alpha(theme.palette.text.primary, 0.06),
                },
              }}
            >
              <SchemaIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip
          title={
            <Box sx={{ display: "inline-flex", alignItems: "center" }}>
              {t("sqlConsole.savePreset")}
              <Kbd>⌘S</Kbd>
            </Box>
          }
          arrow
        >
          <span>
            <IconButton
              size="small"
              onClick={() => {
                setSavePresetName("");
                setSavePresetOpen(true);
              }}
              disabled={!query.trim()}
              aria-label={t("sqlConsole.savePreset")}
              sx={{ width: 32, height: 32 }}
            >
              <StarBorderIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip
          title={
            <Box sx={{ display: "inline-flex", alignItems: "center" }}>
              {t("sqlConsole.clearAll")}
              <Kbd>⌘L</Kbd>
            </Box>
          }
          arrow
        >
          <span>
            <IconButton
              size="small"
              onClick={handleClearAll}
              aria-label={t("sqlConsole.clearAll")}
              disabled={!query.trim() && !result}
              sx={{ width: 32, height: 32 }}
            >
              <ClearIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Box flex={1} />
        <Typography
          variant="caption"
          sx={{
            fontSize: 10,
            color: theme.palette.text.disabled,
            fontFamily: MONO_FONT,
            userSelect: "none",
            display: { xs: "none", md: "inline" },
            mr: result ? 0.5 : 0,
          }}
        >
          {t("sqlConsole.editor.autocomplete")}
        </Typography>
        {result && (
          <Tooltip title={t("sqlConsole.exportCsv")} arrow>
            <IconButton
              size="small"
              onClick={exportCSV}
              aria-label={t("sqlConsole.exportCsv")}
              sx={{ width: 32, height: 32 }}
            >
              <DownloadIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>
    </>
  );
}

/** A click puts a past query back in the editor, never runs it. */
export function HistoryMenu({
  historyAnchor,
  setHistoryAnchor,
  history,
  handleClearHistory,
  setQuery,
  t,
}) {
  const theme = useTheme();
  return (
    <>
      <Menu
        anchorEl={historyAnchor}
        open={Boolean(historyAnchor)}
        onClose={() => setHistoryAnchor(null)}
        slotProps={{
          paper: {
            sx: { minWidth: 360, maxWidth: 520, maxHeight: 400 },
          },
        }}
      >
        <Box sx={{ px: 1.5, py: 0.5, display: "flex", alignItems: "center" }}>
          <Typography
            variant="caption"
            sx={{
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: theme.palette.text.secondary,
            }}
          >
            {t("sqlConsole.history")}
          </Typography>
          <Box flex={1} />
          {history.length > 0 && (
            <Button size="small" onClick={handleClearHistory}>
              {t("sqlConsole.historyClear")}
            </Button>
          )}
        </Box>
        <Divider />
        {history.length === 0 ? (
          <MenuItem disabled>
            <Typography variant="caption">
              {t("sqlConsole.historyEmpty")}
            </Typography>
          </MenuItem>
        ) : (
          history.map((h) => (
            <MenuItem
              key={h.ts}
              onClick={() => {
                setQuery(h.query);
                setHistoryAnchor(null);
              }}
              sx={{ display: "block", py: 0.5 }}
            >
              <Typography
                variant="caption"
                sx={{
                  display: "block",
                  fontSize: 10,
                  color: theme.palette.text.secondary,
                  fontWeight: 600,
                }}
              >
                {formatRelative(h.ts, t)}
              </Typography>
              <Typography
                variant="body2"
                sx={{
                  fontFamily: MONO_FONT,
                  fontSize: 11.5,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: 480,
                }}
              >
                {h.query.length > 80 ? `${h.query.slice(0, 80)}…` : h.query}
              </Typography>
            </MenuItem>
          ))
        )}
      </Menu>
    </>
  );
}

export function SavePresetDialog({
  savePresetOpen,
  setSavePresetOpen,
  savePresetName,
  setSavePresetName,
  handleSavePreset,
  t,
}) {
  return (
    <>
      <Dialog
        open={savePresetOpen}
        onClose={() => setSavePresetOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t("sqlConsole.presetSavePrompt")}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            value={savePresetName}
            onChange={(e) => setSavePresetName(e.target.value)}
            placeholder="My audit query"
            onKeyDown={(e) => {
              if (e.key === "Enter" && savePresetName.trim()) {
                e.preventDefault();
                handleSavePreset();
              }
            }}
            slotProps={{
              htmlInput: {
                "aria-label": t("sqlConsole.presetSavePrompt"),
              },
            }}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSavePresetOpen(false)}>
            {t("app.cancel")}
          </Button>
          <Button
            variant="contained"
            disabled={!savePresetName.trim()}
            onClick={handleSavePreset}
          >
            {t("app.save")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

/** Four downloads and the same four to the clipboard; disabled at the icon when the result has no rows. */
export function ExportMenu({
  exportAnchor,
  setExportAnchor,
  exportCSV,
  exportJSON,
  exportInsertSql,
  exportMarkdown,
  copyExportCsv,
  copyExportJson,
  copyExportSql,
  copyExportMarkdown,
  t,
}) {
  return (
    <>
      {/* The SQL variants use editable.table when known, a generic placeholder for a read-only query. */}
      <Menu
        anchorEl={exportAnchor}
        open={Boolean(exportAnchor)}
        onClose={() => setExportAnchor(null)}
        slotProps={{ paper: { sx: { minWidth: 240 } } }}
      >
        <MenuItem
          dense
          onClick={() => {
            exportCSV();
            setExportAnchor(null);
          }}
        >
          <ListItemIcon sx={{ minWidth: 32 }}>
            <TableViewIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t("sqlConsole.export.csv")} />
        </MenuItem>
        <MenuItem
          dense
          onClick={() => {
            exportJSON();
            setExportAnchor(null);
          }}
        >
          <ListItemIcon sx={{ minWidth: 32 }}>
            <DataObjectIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t("sqlConsole.export.json")} />
        </MenuItem>
        <MenuItem
          dense
          onClick={() => {
            exportInsertSql();
            setExportAnchor(null);
          }}
        >
          <ListItemIcon sx={{ minWidth: 32 }}>
            <IntegrationInstructionsIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t("sqlConsole.export.sql")} />
        </MenuItem>
        <MenuItem
          dense
          onClick={() => {
            exportMarkdown();
            setExportAnchor(null);
          }}
        >
          <ListItemIcon sx={{ minWidth: 32 }}>
            <FormatAlignLeftIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t("sqlConsole.export.markdown")} />
        </MenuItem>
        <Divider sx={{ my: 0.25 }} />
        <MenuItem
          dense
          onClick={() => {
            copyExportCsv();
            setExportAnchor(null);
          }}
        >
          <ListItemIcon sx={{ minWidth: 32 }}>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t("sqlConsole.export.copy.csv")} />
        </MenuItem>
        <MenuItem
          dense
          onClick={() => {
            copyExportJson();
            setExportAnchor(null);
          }}
        >
          <ListItemIcon sx={{ minWidth: 32 }}>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t("sqlConsole.export.copy.json")} />
        </MenuItem>
        <MenuItem
          dense
          onClick={() => {
            copyExportSql();
            setExportAnchor(null);
          }}
        >
          <ListItemIcon sx={{ minWidth: 32 }}>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t("sqlConsole.export.copy.sql")} />
        </MenuItem>
        <MenuItem
          dense
          onClick={() => {
            copyExportMarkdown();
            setExportAnchor(null);
          }}
        >
          <ListItemIcon sx={{ minWidth: 32 }}>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t("sqlConsole.export.copy.markdown")} />
        </MenuItem>
      </Menu>
    </>
  );
}
