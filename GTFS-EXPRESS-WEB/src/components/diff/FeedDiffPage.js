import React, { useCallback, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  IconButton,
  Collapse,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  alpha,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { useDropzone } from "react-dropzone";
import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutline";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import CompareArrowsIcon from "@mui/icons-material/CompareArrows";
import EastIcon from "@mui/icons-material/East";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutline";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import TableChartOutlinedIcon from "@mui/icons-material/TableChartOutlined";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB — same cap as GTFSUploader

// Renders empty-ish cell values visibly so a before→after line never
// collapses into "→" with nothing on either side.
const formatValue = (value) => {
  if (value === null || value === undefined || value === "") return "∅";
  return String(value);
};

// Compact one-line preview of a sample row: first few non-empty columns.
const rowPreview = (row) => {
  if (!row || typeof row !== "object") return "";
  return Object.entries(row)
    .filter(([, v]) => v !== null && v !== undefined && String(v) !== "")
    .slice(0, 4)
    .map(([col, v]) => `${col}=${v}`)
    .join(" · ");
};

// One of the four headline metric cards (added / removed / changed / tables).
function StatCard({ icon: Icon, accent, label, value }) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  return (
    <Paper
      elevation={0}
      sx={{
        borderRadius: "14px",
        border: `1px solid ${alpha(accent, isDark ? 0.24 : 0.15)}`,
        borderLeft: `3px solid ${accent}`,
        backgroundColor: theme.palette.background.paper,
        p: 2,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, mb: 1.5 }}>
        <Box
          sx={{
            width: 30,
            height: 30,
            borderRadius: "8px",
            backgroundColor: alpha(accent, isDark ? 0.24 : 0.14),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Icon sx={{ fontSize: 18, color: accent }} />
        </Box>
        <Typography
          sx={{
            color: theme.palette.text.secondary,
            fontSize: "0.78rem",
            fontWeight: 600,
            letterSpacing: "0.02em",
          }}
        >
          {label}
        </Typography>
      </Box>
      <Typography
        component="div"
        sx={{
          color: theme.palette.text.primary,
          fontSize: "2rem",
          fontWeight: 800,
          letterSpacing: "-0.03em",
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {(value || 0).toLocaleString()}
      </Typography>
    </Paper>
  );
}

// Small count pill used in the per-table breakdown columns.
function CountChip({ value, accent, prefix }) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  if (!value) {
    return (
      <Typography
        component="span"
        sx={{ color: theme.palette.text.disabled, fontSize: "0.8rem" }}
      >
        0
      </Typography>
    );
  }
  return (
    <Chip
      size="small"
      label={`${prefix}${value.toLocaleString()}`}
      sx={{
        height: 22,
        fontWeight: 700,
        fontVariantNumeric: "tabular-nums",
        color: accent,
        backgroundColor: alpha(accent, isDark ? 0.2 : 0.12),
      }}
    />
  );
}

// One expandable row of the per-table breakdown. The Collapse body shows up
// to `sampleLimit` sample rows per category — illustrative, not exhaustive.
function DiffTableRow({ name, info, sampleLimit }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const isDark = theme.palette.mode === "dark";
  const brand = theme.palette.brand;
  const severities = theme.palette.severities;

  const samples = info.samples || {};
  const addedSamples = (samples.added || []).slice(0, sampleLimit);
  const removedSamples = (samples.removed || []).slice(0, sampleLimit);
  const changedSamples = (samples.changed || []).slice(0, sampleLimit);
  const hasSamples =
    addedSamples.length + removedSamples.length + changedSamples.length > 0;

  const sampleGroupSx = {
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: "10px",
    p: 1.25,
  };
  const groupLabelSx = {
    fontSize: "0.68rem",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    mb: 0.75,
  };
  const monoLineSx = {
    fontFamily: "monospace",
    fontSize: "0.76rem",
    color: theme.palette.text.secondary,
    overflowWrap: "anywhere",
  };

  return (
    <>
      <TableRow hover>
        <TableCell sx={{ width: 44, py: 0.5 }}>
          <IconButton
            size="small"
            onClick={() => setOpen((prev) => !prev)}
            disabled={!hasSamples}
            aria-label={name}
            data-testid={`compare-expand-${name}`}
          >
            {open ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
          </IconButton>
        </TableCell>
        <TableCell>
          {/* GTFS table names are spec terms — always literal, never translated */}
          <Typography
            component="span"
            sx={{
              fontFamily: "monospace",
              fontWeight: 600,
              fontSize: "0.85rem",
              color: theme.palette.text.primary,
            }}
          >
            {name}
          </Typography>
        </TableCell>
        <TableCell align="right">
          <CountChip value={info.added} accent={brand.success} prefix="+" />
        </TableCell>
        <TableCell align="right">
          <CountChip
            value={info.removed}
            accent={severities.error.main}
            prefix="−"
          />
        </TableCell>
        <TableCell align="right">
          <CountChip
            value={info.changed}
            accent={severities.warning.main}
            prefix="~"
          />
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={5} sx={{ py: 0, border: 0 }}>
          <Collapse in={open} timeout="auto" unmountOnExit>
            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                gap: 1.25,
                pb: 2,
                pl: { xs: 1, sm: 5.5 },
                pr: 1,
              }}
            >
              {changedSamples.length > 0 && (
                <Box sx={sampleGroupSx}>
                  <Typography
                    sx={{ ...groupLabelSx, color: severities.warning.main }}
                  >
                    {t("compare.table.changed")} — {t("compare.samples.before")}{" "}
                    → {t("compare.samples.after")}
                  </Typography>
                  <Stack spacing={1.25}>
                    {changedSamples.map((sample, idx) => (
                      <Box key={idx}>
                        <Stack
                          direction="row"
                          spacing={0.5}
                          useFlexGap
                          flexWrap="wrap"
                          alignItems="center"
                          sx={{ mb: 0.5 }}
                        >
                          <Chip
                            size="small"
                            label={formatValue(sample.key)}
                            sx={{
                              height: 20,
                              fontFamily: "monospace",
                              fontSize: "0.72rem",
                              fontWeight: 600,
                            }}
                          />
                          <Typography
                            component="span"
                            variant="caption"
                            sx={{ color: theme.palette.text.secondary }}
                          >
                            {t("compare.samples.changedColumns")}:
                          </Typography>
                          {(sample.changedColumns || []).map((col) => (
                            <Chip
                              key={col}
                              size="small"
                              variant="outlined"
                              label={col}
                              sx={{
                                height: 20,
                                fontFamily: "monospace",
                                fontSize: "0.72rem",
                                color: severities.warning.main,
                                borderColor: alpha(
                                  severities.warning.main,
                                  isDark ? 0.5 : 0.35,
                                ),
                              }}
                            />
                          ))}
                        </Stack>
                        {(sample.changedColumns || []).map((col) => (
                          <Box
                            key={col}
                            sx={{
                              display: "flex",
                              alignItems: "center",
                              flexWrap: "wrap",
                              gap: 0.75,
                              fontFamily: "monospace",
                              fontSize: "0.76rem",
                              pl: 0.5,
                              py: 0.25,
                            }}
                          >
                            <Box
                              component="span"
                              sx={{ color: theme.palette.text.secondary }}
                            >
                              {col}:
                            </Box>
                            <Box
                              component="span"
                              sx={{
                                color: severities.error.main,
                                textDecoration: "line-through",
                                textDecorationColor: alpha(
                                  severities.error.main,
                                  0.5,
                                ),
                                overflowWrap: "anywhere",
                              }}
                            >
                              {formatValue(sample.before?.[col])}
                            </Box>
                            <EastIcon
                              sx={{
                                fontSize: 13,
                                color: theme.palette.text.disabled,
                              }}
                            />
                            <Box
                              component="span"
                              sx={{
                                color: brand.success,
                                fontWeight: 600,
                                overflowWrap: "anywhere",
                              }}
                            >
                              {formatValue(sample.after?.[col])}
                            </Box>
                          </Box>
                        ))}
                      </Box>
                    ))}
                  </Stack>
                </Box>
              )}
              {addedSamples.length > 0 && (
                <Box sx={sampleGroupSx}>
                  <Typography sx={{ ...groupLabelSx, color: brand.success }}>
                    {t("compare.table.added")}
                  </Typography>
                  <Stack spacing={0.5}>
                    {addedSamples.map((row, idx) => (
                      <Typography key={idx} sx={monoLineSx}>
                        + {rowPreview(row)}
                      </Typography>
                    ))}
                  </Stack>
                </Box>
              )}
              {removedSamples.length > 0 && (
                <Box sx={sampleGroupSx}>
                  <Typography
                    sx={{ ...groupLabelSx, color: severities.error.main }}
                  >
                    {t("compare.table.removed")}
                  </Typography>
                  <Stack spacing={0.5}>
                    {removedSamples.map((row, idx) => (
                      <Typography key={idx} sx={monoLineSx}>
                        − {rowPreview(row)}
                      </Typography>
                    ))}
                  </Stack>
                </Box>
              )}
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

/**
 * FeedDiffPage — the Compare tab. Read-only feature: uploads the OTHER
 * version of the loaded feed into its own throwaway session (fresh UUID,
 * the main session header is preserved by addSessionHeader), then asks the
 * backend to diff both sessions and renders the per-table breakdown.
 *
 * State machine: idle → uploading → diffing → result | error.
 */
function FeedDiffPage() {
  const theme = useTheme();
  const { t } = useLanguage();
  const [phase, setPhase] = useState("idle");
  const [diff, setDiff] = useState(null);
  // errorInfo: { headlineKey, detailKey?, detailText? } — keys re-resolve on
  // language switch, raw server/network text is shown verbatim.
  const [errorInfo, setErrorInfo] = useState(null);

  const isDark = theme.palette.mode === "dark";
  const brand = theme.palette.brand;
  const severities = theme.palette.severities;

  const reset = useCallback(() => {
    setPhase("idle");
    setDiff(null);
    setErrorInfo(null);
  }, []);

  const runCompare = useCallback(async (file) => {
    setPhase("uploading");
    setDiff(null);
    setErrorInfo(null);
    // The other feed gets its own backend session so the loaded one is
    // never touched. fetchWithSession preserves this explicit header.
    const otherSessionId = crypto.randomUUID();
    let stage = "upload";
    try {
      const formData = new FormData();
      formData.append("gtfsZip", file);
      const uploadResponse = await fetchWithSession(`${API_BASE_URL}/upload`, {
        method: "POST",
        body: formData,
        headers: { "X-Session-ID": otherSessionId },
      });
      if (!uploadResponse.ok) {
        const payload = await uploadResponse.json().catch(() => null);
        setErrorInfo({
          headlineKey: "compare.error.upload",
          detailText:
            payload?.error ||
            payload?.detail ||
            payload?.message ||
            `HTTP ${uploadResponse.status}`,
        });
        setPhase("error");
        return;
      }

      stage = "diff";
      setPhase("diffing");
      const diffResponse = await fetchWithSession(`${API_BASE_URL}/diff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otherSessionId }),
      });
      if (!diffResponse.ok) {
        const payload = await diffResponse.json().catch(() => null);
        setErrorInfo({
          headlineKey: "compare.error.diff",
          detailText:
            payload?.error ||
            payload?.detail ||
            payload?.message ||
            `HTTP ${diffResponse.status}`,
        });
        setPhase("error");
        return;
      }
      setDiff(await diffResponse.json());
      setPhase("result");
    } catch (err) {
      // err.isRateLimit carries the backend limiter message (fetchWithSession
      // converts HTTP 429 into a typed error).
      setErrorInfo({
        headlineKey:
          stage === "upload" ? "compare.error.upload" : "compare.error.diff",
        detailText: err.message,
      });
      setPhase("error");
    }
  }, []);

  const onDrop = useCallback(
    (acceptedFiles) => {
      if (!acceptedFiles || acceptedFiles.length === 0) return;
      runCompare(acceptedFiles[0]);
    },
    [runCompare],
  );

  const onDropRejected = useCallback((rejectedFiles) => {
    const firstError = rejectedFiles?.[0]?.errors?.[0];
    setErrorInfo({
      headlineKey: "compare.error.upload",
      detailKey:
        firstError?.code === "file-too-large"
          ? "compare.error.tooLarge"
          : "compare.error.invalidType",
    });
    setPhase("error");
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    onDropRejected,
    accept: { "application/zip": [".zip"] },
    maxSize: MAX_UPLOAD_BYTES,
    multiple: false,
    disabled: phase !== "idle",
  });

  const summary = diff?.summary || {};
  const identical = phase === "result" && summary.tablesWithChanges === 0;
  const changedTables = diff
    ? Object.entries(diff.tables || {})
        .filter(
          ([, info]) =>
            (info.added || 0) + (info.removed || 0) + (info.changed || 0) > 0,
        )
        .sort(([a], [b]) => a.localeCompare(b))
    : [];

  const resetButton = (
    <Button
      data-testid="compare-reset"
      onClick={reset}
      variant="outlined"
      size="small"
      startIcon={<RestartAltIcon />}
    >
      {t("compare.reset")}
    </Button>
  );

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", pb: 4 }}>
      <Container maxWidth="lg" sx={{ pt: 3, px: { xs: 2, md: 3 } }}>
        {/* Page header */}
        <Box sx={{ mb: 3 }}>
          <Typography
            variant="h4"
            component="h1"
            sx={{
              color: theme.palette.text.primary,
              fontWeight: 800,
              letterSpacing: "-0.02em",
              fontSize: { xs: "1.4rem", md: "1.7rem" },
              mb: 0.5,
            }}
          >
            {t("compare.title")}
          </Typography>
          <Typography
            variant="body2"
            sx={{ color: theme.palette.text.secondary, maxWidth: 640 }}
          >
            {t("compare.intro")}
          </Typography>
        </Box>

        {phase === "idle" && (
          <Box sx={{ display: "flex", justifyContent: "center", pt: 2 }}>
            <Paper
              data-testid="compare-dropzone"
              {...getRootProps()}
              elevation={0}
              sx={{
                width: "100%",
                maxWidth: 560,
                borderRadius: "14px",
                border: `2px dashed ${
                  isDragActive
                    ? theme.palette.primary.main
                    : theme.palette.divider
                }`,
                backgroundColor: isDragActive
                  ? alpha(theme.palette.primary.main, isDark ? 0.1 : 0.04)
                  : theme.palette.background.paper,
                p: { xs: 4, md: 6 },
                textAlign: "center",
                cursor: "pointer",
                transition: "all 0.2s ease",
                "&:hover": {
                  borderColor: theme.palette.primary.main,
                  backgroundColor: alpha(
                    theme.palette.primary.main,
                    isDark ? 0.08 : 0.03,
                  ),
                },
              }}
            >
              <input {...getInputProps()} />
              <Box
                sx={{
                  width: 56,
                  height: 56,
                  borderRadius: "14px",
                  backgroundColor: alpha(
                    theme.palette.primary.main,
                    isDark ? 0.2 : 0.1,
                  ),
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  mx: "auto",
                  mb: 2,
                }}
              >
                <CompareArrowsIcon
                  sx={{ fontSize: 30, color: theme.palette.primary.main }}
                />
              </Box>
              <Typography
                variant="h6"
                sx={{ color: theme.palette.text.primary, mb: 0.75 }}
              >
                {t("compare.dropTitle")}
              </Typography>
              <Typography
                variant="body2"
                sx={{ color: theme.palette.text.secondary }}
              >
                {t("compare.dropHint")}
              </Typography>
            </Paper>
          </Box>
        )}

        {(phase === "uploading" || phase === "diffing") && (
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2.5,
              pt: 8,
            }}
          >
            <CircularProgress size={52} thickness={3} />
            <Typography
              variant="body1"
              sx={{ color: theme.palette.text.secondary, fontWeight: 500 }}
            >
              {phase === "uploading"
                ? t("compare.uploading")
                : t("compare.diffing")}
            </Typography>
          </Box>
        )}

        {phase === "error" && errorInfo && (
          <Box sx={{ maxWidth: 640, mx: "auto", pt: 2 }}>
            <Alert severity="error" sx={{ mb: 2.5 }}>
              <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.25 }}>
                {t(errorInfo.headlineKey)}
              </Typography>
              <Typography variant="body2">
                {errorInfo.detailKey
                  ? t(errorInfo.detailKey)
                  : errorInfo.detailText}
              </Typography>
            </Alert>
            <Box sx={{ display: "flex", justifyContent: "center" }}>
              {resetButton}
            </Box>
          </Box>
        )}

        {phase === "result" && diff && (
          <>
            {/* Direction caption + reset */}
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 1.5,
                mb: 2,
              }}
            >
              <Chip
                icon={<CompareArrowsIcon sx={{ fontSize: 16 }} />}
                label={t("compare.direction")}
                size="small"
                variant="outlined"
                sx={{ color: theme.palette.text.secondary }}
              />
              {resetButton}
            </Box>

            {/* Summary stat cards */}
            <Box
              data-testid="compare-summary"
              sx={{
                display: "grid",
                gridTemplateColumns: {
                  xs: "repeat(2, 1fr)",
                  md: "repeat(4, 1fr)",
                },
                gap: 2,
                mb: 3,
              }}
            >
              <StatCard
                icon={AddCircleOutlineIcon}
                accent={brand.success}
                label={t("compare.summary.added")}
                value={summary.added}
              />
              <StatCard
                icon={RemoveCircleOutlineIcon}
                accent={brand.error}
                label={t("compare.summary.removed")}
                value={summary.removed}
              />
              <StatCard
                icon={EditOutlinedIcon}
                accent={brand.warning}
                label={t("compare.summary.changed")}
                value={summary.changed}
              />
              <StatCard
                icon={TableChartOutlinedIcon}
                accent={brand.info}
                label={t("compare.summary.tables")}
                value={summary.tablesWithChanges}
              />
            </Box>

            {identical ? (
              <Paper
                data-testid="compare-identical"
                elevation={0}
                sx={{
                  borderRadius: "14px",
                  border: `1px solid ${alpha(brand.success, isDark ? 0.3 : 0.2)}`,
                  backgroundColor: alpha(brand.success, isDark ? 0.12 : 0.05),
                  p: { xs: 4, md: 6 },
                  textAlign: "center",
                }}
              >
                <CheckCircleOutlineIcon
                  sx={{ fontSize: 52, color: brand.success, mb: 1.5 }}
                />
                <Typography
                  variant="h6"
                  sx={{ color: theme.palette.text.primary, mb: 0.75 }}
                >
                  {t("compare.identical.title")}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{
                    color: theme.palette.text.secondary,
                    maxWidth: 480,
                    mx: "auto",
                  }}
                >
                  {t("compare.identical.body")}
                </Typography>
              </Paper>
            ) : (
              <TableContainer
                component={Paper}
                elevation={0}
                sx={{
                  borderRadius: "14px",
                  border: `1px solid ${theme.palette.divider}`,
                  backgroundColor: theme.palette.background.paper,
                }}
              >
                <Table size="small" aria-label={t("compare.table.header")}>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ width: 44 }} />
                      <TableCell sx={{ fontWeight: 700 }}>
                        {t("compare.table.header")}
                      </TableCell>
                      <TableCell
                        align="right"
                        sx={{ fontWeight: 700, color: brand.success }}
                      >
                        {t("compare.table.added")}
                      </TableCell>
                      <TableCell
                        align="right"
                        sx={{ fontWeight: 700, color: severities.error.main }}
                      >
                        {t("compare.table.removed")}
                      </TableCell>
                      <TableCell
                        align="right"
                        sx={{ fontWeight: 700, color: severities.warning.main }}
                      >
                        {t("compare.table.changed")}
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {changedTables.map(([name, info]) => (
                      <DiffTableRow
                        key={name}
                        name={name}
                        info={info}
                        sampleLimit={diff.sampleLimit}
                      />
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </>
        )}
      </Container>
    </Box>
  );
}

export default FeedDiffPage;
