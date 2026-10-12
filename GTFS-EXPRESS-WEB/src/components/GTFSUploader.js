/**
 * GTFSUploader — the explorer card's body on Home: "Explorer un réseau"
 * (target design §4 A0, `ExplorerCard`). Reduced from the former landing:
 * the flows, the hero, the list of works and the marketing now live in Home
 * (home/Home.js, home/FlowCards.js, home/ProjectList.js, home/LearnMore.js).
 *
 * What stays is the technicians' path, read free and without an account:
 *   - the GTFS drop zone (`uploader-dropzone`, `[data-dropzone-anchor]`):
 *     the file is uploaded, validated and loaded — a feed with canonical
 *     errors lands on the repair station, a structural rejection says which
 *     file, line and field;
 *   - the demo network (`uploader-load-sample`);
 *   - "Ouvrir un fichier de travail (.gtfsproj)" (`backup-open`): a working
 *     file saved earlier, opened as the session. Under the paid offer a
 *     refused opening opens the offer by itself (`openProject`'s `paywall`):
 *     nothing is asked here. Home's "Travaux récupérés sur cet
 *     ordinateur" (RecoveredWorks) opens its snapshots through the same path
 *     (the `gtfs:open-working-file` event), so there is one opener.
 *
 * `compact`: Home's explorer panel beside the network to modify (2026-10-08): the drop zone in one row, its icon on
 * the left, the rescue hint left to the validation page. `dropzone` false: no zone of its own — Home's finder takes
 * the file and hands it here to be read (READ_GTFS_FILE_EVENT, or « gtfs:pick-gtfs-file » for the picker), so the read
 * path (its phases, its refusals, the repair station) stays this one.
 */

import React, { useEffect, useRef, useState } from "react";
import { Typography, Box, LinearProgress, Alert, Paper, Button, useTheme, alpha } from "@mui/material";
import { useDropzone } from "react-dropzone";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import DirectionsBus from "@mui/icons-material/DirectionsBus";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import ReaderTour from "./home/ReaderTour";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import VerifiedIcon from "@mui/icons-material/Verified";
import { keyframes } from "@mui/system";
import API_BASE_URL from "../config";
import { fetchWithSession } from "../utils/sessionManager";
import { useLanguage } from "../contexts/LanguageContext";
import { useEditMode } from "../contexts/EditModeContext";
import { useDestructiveGuard } from "../contexts/DestructiveGuardContext";
import { PROJECT_EXT } from "../utils/projectFile";
import { RULES_PATH, useNavigate } from "../utils/routes";

/** The event Home's recovered works send to open a working file here (detail: { file }). */
export const OPEN_WORKING_FILE_EVENT = "gtfs:open-working-file";
/** The event Home's finder sends to read a GTFS file here (detail: { file }): uploaded, validated, opened in the reader. */
export const READ_GTFS_FILE_EVENT = "gtfs:read-gtfs-file";

const bounceAnimation = keyframes`
  0%, 100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-10px);
  }
`;

const floatAnimation = keyframes`
  0%, 100% {
    transform: translateY(0px);
  }
  50% {
    transform: translateY(-8px);
  }
`;

const pulseAnimation = keyframes`
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.7;
    transform: scale(1.05);
  }
`;

const rippleAnimation = keyframes`
  0% {
    transform: scale(0.8);
    opacity: 1;
  }
  100% {
    transform: scale(2);
    opacity: 0;
  }
`;

function GTFSUploader({ onUploadSuccess, onLoadSample, onProjectOpened, sampleError, compact = false, dropzone = true }) {
  const baseUrl = API_BASE_URL;
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { openProject } = useEditMode();
  const { guard } = useDestructiveGuard();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  const [uploading, setUploading] = useState(false);
  // Elapsed seconds since the upload started — drives the phase message
  // ("sending" → "validating" → "building") so the user knows the long
  // silent step is normal and bounded, instead of an endless bar.
  const [uploadElapsed, setUploadElapsed] = useState(0);
  useEffect(() => {
    if (!uploading) {
      setUploadElapsed(0);
      return undefined;
    }
    const startedAt = Date.now();
    const id = setInterval(
      () => setUploadElapsed(Math.round((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [uploading]);
  const uploadPhaseKey =
    uploadElapsed < 3
      ? "uploader.phase.sending"
      : uploadElapsed < 45
        ? "uploader.phase.validating"
        : "uploader.phase.building";
  const [loadingSample, setLoadingSample] = useState(false);
  const [errors, setErrors] = useState(null);
  const [isDragActive, setIsDragActive] = useState(false);

  // ── The working file (.gtfsproj): opening ───────────────────────────────
  // Isolated from the ZIP upload so that the two flows expose distinct
  // progress messages ("Uploading 45%…" for the ZIP, "Opening…" for the
  // working file, which includes validation + CSV dump).
  const [openingProject, setOpeningProject] = useState(false);
  const [openingProgress, setOpeningProgress] = useState(0);
  const projectInputRef = useRef(null);

  // ── Project handlers ──────────────────────────────────────────────────────

  const handleOpenProjectFile = async (file) => {
    if (!file) return;
    // Opening a project replaces the current edit session. If there are
    // in-progress changes on a DIFFERENT feed, we protect the user with the
    // "save and continue" option, which will save the current project
    // in a .gtfsproj file before opening a new one.
    guard(
      async () => {
        setErrors(null);
        setOpeningProject(true);
        setOpeningProgress(0);
        try {
          // A refusal is said by the context (a toast, or the offer under the paid model).
          const result = await openProject(file, (p) => setOpeningProgress(p));
          if (result?.ok && onProjectOpened) await onProjectOpened();
        } finally {
          setOpeningProject(false);
          setOpeningProgress(0);
          if (projectInputRef.current) projectInputRef.current.value = "";
        }
      },
      { reason: "openProject" },
    );
  };

  const handlePickProjectFile = () => {
    if (projectInputRef.current) projectInputRef.current.click();
  };


  // Home's recovered works open their snapshot through this one opener.
  const openRef = useRef(null);
  openRef.current = handleOpenProjectFile;
  useEffect(() => {
    const handler = (e) => {
      if (e?.detail?.file) openRef.current?.(e.detail.file);
    };
    window.addEventListener(OPEN_WORKING_FILE_EVENT, handler);
    return () => window.removeEventListener(OPEN_WORKING_FILE_EVENT, handler);
  }, []);

  const performUpload = async (file) => {
    const formData = new FormData();
    formData.append("gtfsZip", file);
    setUploading(true);
    setErrors(null);

    // The existing sessionId is reused via fetchWithSession (replaces data
    // for the same session).
    try {
      // fetchWithSession injects X-Session-ID and converts HTTP 429 into a
      // typed isRateLimit error handled in the catch below.
      const response = await fetchWithSession(`${baseUrl}/upload`, {
        method: "POST",
        body: formData,
      });

      // Handle server errors (502/503/504) — HTML response, not JSON
      if (
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504
      ) {
        setErrors([
          {
            fileName: "⚠️ Server Error",
            errors: [
              {
                line: "N/A",
                field: "N/A",
                message:
                  "The server could not process the file (timeout or insufficient memory). " +
                  "This usually occurs with very large files. " +
                  "Please try again in a moment.",
              },
            ],
          },
        ]);
        return;
      }

      // Try to parse the JSON response (fallback plain text)
      let result;
      try {
        const text = await response.text();
        try {
          result = JSON.parse(text);
        } catch {
          // Response is not JSON — display raw text
          setErrors([
            {
              fileName: "⚠️ Server Error",
              errors: [
                {
                  message:
                    text ||
                    `Server error (HTTP ${response.status}). Please try again.`,
                },
              ],
            },
          ]);
          return;
        }
      } catch {
        setErrors([
          {
            fileName: "⚠️ Network Error",
            errors: [
              {
                message: `Could not read server response (HTTP ${response.status}). Please try again.`,
              },
            ],
          },
        ]);
        return;
      }

      if (!response.ok) {
        // Hard rejection: rows without GTFS-required fields (the engine can
        // not even load them). Show WHICH file / line / field, grouped per
        // file, instead of one generic sentence — this branch used to be
        // shadowed by the generic `result.error` handling below.
        if (result.type === "REQUIRED_FIELDS_MISSING" && Array.isArray(result.errors)) {
          const perFile = new Map();
          for (const e of result.errors.slice(0, 500)) {
            const file = `${e.table || "unknown"}.txt`;
            if (!perFile.has(file)) perFile.set(file, []);
            perFile.get(file).push({
              line: e.lineNumber ?? "N/A",
              field: e.field || "N/A",
              message: t("upload.requiredFieldMissing", {
                field: e.field || "?",
                value: e.value == null || e.value === "" ? "∅" : String(e.value),
              }),
            });
          }
          const total = result.summary?.totalErrors ?? result.errors.length;
          setErrors([
            {
              fileName: t("upload.rejectedTitle", { count: total }),
              errors: [
                {
                  line: "N/A",
                  field: "N/A",
                  message: t("upload.rejectedBody"),
                },
              ],
            },
            ...[...perFile.entries()].map(([fileName, errors]) => ({ fileName, errors })),
          ]);
          return;
        }
        // Autres erreurs
        if (result.error) {
          setErrors([
            {
              fileName: "⚠️ Error",
              errors: [
                {
                  line: "N/A",
                  field: "N/A",
                  // Middleware answers carry a human explanation in `message`
                  // ("invalid magic bytes", "server at capacity"…).
                  message: result.message ? `${result.error} — ${result.message}` : result.error,
                },
              ],
            },
          ]);
        } else if (result.detail) {
          setErrors([
            {
              fileName: "⚠️ Error",
              errors: [
                {
                  line: "N/A",
                  field: "N/A",
                  message: result.detail,
                },
              ],
            },
          ]);
        } else if (result.errors) {
          // Structural rejection (e.g. REQUIRED_FIELDS_MISSING): the backend
          // created no session — flag it so the app shows the full-screen
          // report with re-upload as the only exit. Feeds with canonical
          // findings now come back as HTTP 200 + a live session (rescue
          // flow) and never reach this branch.
          onUploadSuccess(null, {
            valid: false,
            structural: true,
            errors: result.errors,
          });
        } else {
          setErrors([
            {
              fileName: "⚠️ Unknown Error",
              errors: [{ message: "An unexpected error occurred." }],
            },
          ]);
        }
        return;
      }

      const { validationReport, editSessionDropped, pendingEditsLost } = result;
      onUploadSuccess(null, validationReport, {
        editSessionDropped: Boolean(editSessionDropped),
        pendingEditsLost: pendingEditsLost || 0,
        migrationFailed: Boolean(result.migrationFailed),
        migrationError: result.migrationError || null,
        importAdjustments: result.importAdjustments || {},
      });
    } catch (error) {
      if (error.isRateLimit) {
        setErrors([
          {
            fileName: "⚠️ Rate Limit Reached",
            errors: [
              {
                line: "N/A",
                field: "Rate Limit",
                message:
                  error.message ||
                  "Upload limit reached. Please wait before trying again.",
              },
            ],
          },
        ]);
        return;
      }
      setErrors([
        {
          fileName: "⚠️ Network Error",
          errors: [
            {
              line: "N/A",
              field: "N/A",
              message:
                "Unable to reach the server. Check your connection and try again.",
            },
          ],
        },
      ]);
    } finally {
      setUploading(false);
    }
  };

  // Guarded wrapper: if we are in edit mode with changes, asks for confirmation
  // before starting the upload (which destroys the edit session on the backend).
  const onDrop = async (acceptedFiles) => {
    if (!acceptedFiles || acceptedFiles.length === 0) return;
    const file = acceptedFiles[0];
    guard(() => performUpload(file), { reason: "upload" });
  };

  const {
    getRootProps,
    getInputProps,
    open: openFilePicker,
    isDragActive: dropzoneIsDragActive,
  } = useDropzone({
    onDrop,
    accept: {
      "application/zip": [".zip"],
    },
    maxSize: 50 * 1024 * 1024, // 50 MB
    multiple: false,
    onDragEnter: () => setIsDragActive(true),
    onDragLeave: () => setIsDragActive(false),
    onDropAccepted: () => setIsDragActive(false),
    onDropRejected: (rejectedFiles) => {
      setIsDragActive(false);
      const firstFile = rejectedFiles[0];
      const firstError = firstFile?.errors?.[0];
      const droppedName = (firstFile?.file?.name || "").toLowerCase();
      let message;
      // Priority case: a `.gtfsproj` was dropped on the ZIP dropzone.
      // We redirect explicitly to the "Open a project" button rather than
      // a generic error — the user learns the correct action.
      if (droppedName.endsWith(PROJECT_EXT)) {
        message = t("uploader.droppedProjectInstead");
      } else if (firstError?.code === "file-too-large") {
        message = `File is too large (max 50 MB). Received: ${Math.round((firstFile.file.size / 1024 / 1024) * 10) / 10} MB`;
      } else if (
        firstError?.code === "file-invalid-type" ||
        !droppedName.endsWith(".zip")
      ) {
        message =
          "Invalid file format. Please upload a ZIP archive containing your GTFS .txt files.";
      } else {
        message =
          "File rejected. Please upload a valid GTFS ZIP archive (max 50 MB).";
      }
      setErrors([
        {
          fileName: "⚠️ Invalid file",
          errors: [{ message }],
        },
      ]);
    },
  });
  // "…or drop your GTFS file" (the find-network dialog): bring the drop
  // zone into view and open the file picker.
  useEffect(() => {
    const handler = () => {
      document.querySelector("[data-dropzone-anchor]")?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      openFilePicker();
    };
    window.addEventListener("gtfs:pick-gtfs-file", handler);
    return () => window.removeEventListener("gtfs:pick-gtfs-file", handler);
  }, [openFilePicker]);
  // A file Home's finder was given to read: the same path as a file dropped on the zone.
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  useEffect(() => {
    const handler = (e) => {
      const file = e?.detail?.file;
      if (file) onDropRef.current([file]);
    };
    window.addEventListener(READ_GTFS_FILE_EVENT, handler);
    return () => window.removeEventListener(READ_GTFS_FILE_EVENT, handler);
  }, []);
  const surface = isDark ? "#132f4c" : "#ffffff";
  const border = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)";
  const textPrimary = isDark ? "#ffffff" : "#1e293b";
  // The theme's secondary text: it reads 4.5:1 on the tinted cards too (WP9).
  const textSecondary = theme.palette.text.secondary;
  const accentRaw = isDark ? "#60a5fa" : "#3b82f6";

  return (
    <Box data-testid="explorer-card" sx={{ display: "flex", flexDirection: "column", width: "100%" }}>
        {/* ───── DROPZONE (anchor for the Read mode "Try it now" CTA) ─────
            The technicians' path: a GTFS file to explore, validate and repair. */}
        <Box
          data-dropzone-anchor
          sx={{
            mb: 1.25,
            position: "relative",
          }}
        >
          {/* Without its zone, the picker's input stays (« gtfs:pick-gtfs-file » opens it). */}
          {!dropzone && <input {...getInputProps({ "aria-label": t("uploader.dropIdle") })} />}
          {!uploading && dropzone && (
            <Paper
              elevation={0}
              {...getRootProps()}
              data-testid="uploader-dropzone"
              aria-label={t("uploader.dropIdle")}
              sx={{
                position: "relative",
                overflow: "hidden",
                border: `2px dashed ${isDragActive ? accentRaw : border}`,
                borderRadius: compact ? "14px" : "18px",
                p: compact ? 1.75 : { xs: 2, md: 2.25 },
                textAlign: compact ? "left" : "center",
                backgroundColor: isDragActive
                  ? alpha(accentRaw, isDark ? 0.08 : 0.03)
                  : surface,
                cursor: "pointer",
                transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                transform: isDragActive ? "scale(1.015)" : "scale(1)",
                boxShadow: isDragActive
                  ? `0 0 40px ${alpha(accentRaw, 0.25)}`
                  : isDark
                    ? "0 8px 32px rgba(0,0,0,0.4)"
                    : "0 8px 32px rgba(0,0,0,0.08)",
                "&:hover": {
                  borderColor: accentRaw,
                  transform: "scale(1.01)",
                  boxShadow: isDark
                    ? "0 12px 40px rgba(0,0,0,0.5)"
                    : "0 12px 40px rgba(0,0,0,0.12)",
                },
              }}
            >
              {/* The hidden file input the zone opens: named like the zone (RGAA 11.1). */}
              <input {...getInputProps({ "aria-label": t("uploader.dropIdle") })} />

              {/* Ripple effect on drag */}
              {isDragActive && (
                <Box
                  sx={{
                    position: "absolute",
                    top: "50%",
                    left: "50%",
                    width: "100px",
                    height: "100px",
                    borderRadius: "50%",
                    border: `2px solid ${accentRaw}`,
                    transform: "translate(-50%, -50%)",
                    animation: `${rippleAnimation} 1.5s infinite`,
                    pointerEvents: "none",
                  }}
                />
              )}

              <Box
                display="flex"
                flexDirection={compact ? "row" : "column"}
                flexWrap={compact ? "wrap" : undefined}
                alignItems="center"
                justifyContent={compact ? "flex-start" : "center"}
                gap={compact ? 1.5 : 2}
              >
                {/* Icon container */}
                <Box
                  sx={{
                    width: 48,
                    height: 48,
                    borderRadius: "18px",
                    background: isDragActive
                      ? `linear-gradient(135deg, ${alpha(accentRaw, 0.2)}, ${alpha(accentRaw, 0.1)})`
                      : isDark
                        ? "linear-gradient(135deg, rgba(96,165,250,0.12), rgba(96,165,250,0.06))"
                        : "linear-gradient(135deg, rgba(59,130,246,0.08), rgba(59,130,246,0.03))",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    animation: isDragActive
                      ? `${pulseAnimation} 0.8s ease-in-out infinite`
                      : `${floatAnimation} 3s ease-in-out infinite`,
                  }}
                >
                  <CloudUploadIcon
                    sx={{
                      fontSize: 28,
                      color: accentRaw,
                      filter: isDragActive
                        ? `drop-shadow(0 0 8px ${alpha(accentRaw, 0.5)})`
                        : "none",
                    }}
                  />
                </Box>

                <Box sx={{ flex: compact ? 1 : undefined, minWidth: 0 }}>
                  <Typography
                    component="span"
                    fontWeight={700}
                    sx={{
                      display: "block",
                      color: isDragActive ? accentRaw : textPrimary,
                      mb: 0.5,
                      transition: "color 0.3s ease",
                      fontSize: "0.92rem",
                    }}
                  >
                    {isDragActive
                      ? t("uploader.dropActive")
                      : t("uploader.dropIdle")}
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{ color: textSecondary, mb: compact ? 0 : 1, fontSize: "0.78rem" }}
                  >
                    {isDragActive
                      ? t("uploader.dropHintActive")
                      : compact
                        ? `${t("uploader.dropHintIdle")} · ${t("uploader.fileSpec")}`
                        : t("uploader.dropHintIdle")}
                  </Typography>
                </Box>

                {/* File specs + validator pills */}
                <Box
                  sx={{
                    display: "inline-flex",
                    flexWrap: "wrap",
                    justifyContent: compact ? "flex-start" : "center",
                    alignItems: "center",
                    gap: 1,
                    ...(compact ? { width: "100%", "& > *": { px: "10px !important", py: "4px !important", gap: "6px !important" } } : {}),
                  }}
                >
                  <Box
                    sx={{
                      display: compact ? "none" : "inline-flex",
                      alignItems: "center",
                      gap: 1.5,
                      px: 2.5,
                      py: 1,
                      backgroundColor: isDark
                        ? alpha("#fff", 0.04)
                        : alpha("#000", 0.02),
                      borderRadius: "10px",
                      border: `1px solid ${border}`,
                    }}
                  >
                    <FileUploadOutlinedIcon
                      sx={{ fontSize: 16, color: textSecondary }}
                    />
                    <Typography
                      variant="caption"
                      sx={{
                        color: textSecondary,
                        fontWeight: 500,
                        fontSize: "0.73rem",
                      }}
                    >
                      {t("uploader.fileSpec")}
                    </Typography>
                  </Box>

                  {/* The rules the validator checks: the app's own page (/regles), which links to MobilityData's. */}
                  <Box
                    component="a"
                    href={RULES_PATH}
                    onClick={(e) => {
                      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                      e.preventDefault();
                      navigate(RULES_PATH);
                    }}
                    sx={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 1.5,
                      px: 2.5,
                      py: 1,
                      backgroundColor: isDark
                        ? alpha("#22c55e", 0.08)
                        : alpha("#16a34a", 0.06),
                      borderRadius: "10px",
                      border: `1px solid ${
                        isDark ? alpha("#22c55e", 0.25) : alpha("#16a34a", 0.2)
                      }`,
                      textDecoration: "none",
                      transition: "all 0.18s cubic-bezier(0.4, 0, 0.2, 1)",
                      "&:hover": {
                        backgroundColor: isDark
                          ? alpha("#22c55e", 0.14)
                          : alpha("#16a34a", 0.1),
                        borderColor: isDark
                          ? alpha("#22c55e", 0.4)
                          : alpha("#16a34a", 0.35),
                      },
                    }}
                  >
                    <VerifiedIcon
                      sx={{
                        fontSize: 16,
                        color: isDark ? "#22c55e" : "#16a34a",
                      }}
                    />
                    <Typography
                      variant="caption"
                      sx={{
                        color: isDark ? "#86efac" : "#15803d",
                        fontWeight: 600,
                        fontSize: "0.73rem",
                      }}
                    >
                      {t("uploader.poweredBy")}
                    </Typography>
                    {!compact && (
                      <Typography
                        variant="caption"
                        sx={{ color: textSecondary, display: "block", mt: 0.5 }}
                      >
                        {t("uploader.rescueHint")}
                      </Typography>
                    )}
                  </Box>
                </Box>

              </Box>
            </Paper>
          )}

          {uploading && (
            <Paper
              elevation={0}
              sx={{
                p: 5,
                backgroundColor: surface,
                borderRadius: "18px",
                border: `1px solid ${border}`,
                boxShadow: isDark
                  ? "0 8px 32px rgba(0,0,0,0.4)"
                  : "0 8px 32px rgba(0,0,0,0.08)",
                textAlign: "center",
              }}
            >
              <Box
                display="flex"
                justifyContent="center"
                alignItems="center"
                flexDirection="column"
                gap={2}
              >
                <Box display="flex" alignItems="center" gap={1}>
                  <DirectionsBus
                    sx={{
                      fontSize: 32,
                      color: accentRaw,
                      animation: `${bounceAnimation} 0.6s ease-in-out infinite`,
                    }}
                  />
                  <Typography
                    variant="h6"
                    sx={{ color: textPrimary, fontWeight: 600 }}
                  >
                    {t("uploader.processingTitle")}
                  </Typography>
                </Box>
                <LinearProgress
                  sx={{
                    width: "100%",
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: isDark ? "#334155" : "#e2e8f0",
                    "& .MuiLinearProgress-bar": {
                      backgroundColor: accentRaw,
                      borderRadius: 3,
                    },
                  }}
                />
                <Typography
                  variant="body2"
                  sx={{ color: textPrimary, fontWeight: 500 }}
                  data-testid="uploader-phase"
                >
                  {t(uploadPhaseKey)}
                </Typography>
                <Typography variant="caption" sx={{ color: textSecondary }}>
                  {t("uploader.processingDesc")} ·{" "}
                  {t("uploader.phase.elapsed", { seconds: uploadElapsed })}
                </Typography>
              </Box>
            </Paper>
          )}

          {openingProject && (
            <Paper
              elevation={0}
              sx={{
                p: 5,
                backgroundColor: surface,
                borderRadius: "18px",
                border: `1px solid ${border}`,
                boxShadow: isDark
                  ? "0 8px 32px rgba(0,0,0,0.4)"
                  : "0 8px 32px rgba(0,0,0,0.08)",
                textAlign: "center",
              }}
            >
              <Box
                display="flex"
                justifyContent="center"
                alignItems="center"
                flexDirection="column"
                gap={2}
              >
                <Box display="flex" alignItems="center" gap={1}>
                  <FolderOpenOutlinedIcon
                    sx={{
                      fontSize: 32,
                      color: accentRaw,
                      animation: `${pulseAnimation} 1.2s ease-in-out infinite`,
                    }}
                  />
                  <Typography
                    id="uploader-opening-project"
                    variant="h6"
                    sx={{ color: textPrimary, fontWeight: 600 }}
                  >
                    {t("uploader.openingProject")}
                  </Typography>
                </Box>
                <LinearProgress
                  variant={
                    openingProgress > 0 && openingProgress < 100
                      ? "determinate"
                      : "indeterminate"
                  }
                  value={openingProgress}
                  aria-labelledby="uploader-opening-project"
                  sx={{
                    width: "100%",
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: isDark ? "#334155" : "#e2e8f0",
                    "& .MuiLinearProgress-bar": {
                      backgroundColor: accentRaw,
                      borderRadius: 3,
                    },
                  }}
                />
                <Typography variant="caption" sx={{ color: textSecondary }}>
                  {openingProgress > 0 && openingProgress < 100
                    ? t("uploader.uploadingProgress", {
                        percent: openingProgress,
                      })
                    : t("uploader.openingProjectDesc")}
                </Typography>
              </Box>
            </Paper>
          )}

          {errors && (
            <Box marginTop={2}>
              {errors.map((fileError, index) => (
                <Alert
                  key={index}
                  severity="error"
                  sx={{ mb: 1, borderRadius: "12px" }}
                >
                  <strong>{fileError.fileName}</strong>
                  {fileError.errors.map((e, i) => (
                    <Typography key={i} variant="body2" sx={{ mt: 0.5 }}>
                      {e.message}
                    </Typography>
                  ))}
                </Alert>
              ))}
            </Box>
          )}
        </Box>
        {/* Hidden file input for .gtfsproj picker — triggered by the "Open project" tile */}
        <input
          type="file"
          accept=".gtfsproj,application/octet-stream"
          ref={projectInputRef}
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            if (f) handleOpenProjectFile(f);
          }}
        />

        {/* ───── The demo network and the working file ───── */}
        {!uploading && !openingProject && !loadingSample && (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {sampleError && (
              <Alert severity="warning" sx={{ borderRadius: "12px" }}>
                {sampleError}
              </Alert>
            )}
              {/* Tile: Try the sample */}
              <Paper
                component="button"
                elevation={0}
                data-testid="uploader-load-sample"
                onClick={() => {
                  if (!onLoadSample) return;
                  guard(
                    async () => {
                      setLoadingSample(true);
                      try {
                        await onLoadSample();
                      } finally {
                        setLoadingSample(false);
                      }
                    },
                    { reason: "loadSample" },
                  );
                }}
                sx={{
                  display: "flex",
                  // Compact (Home): a preview of the demo's own overview above its name — what one gets, in sight.
                  flexDirection: compact ? "column" : "row",
                  alignItems: compact ? "stretch" : "center",
                  gap: compact ? 0 : 2,
                  width: "100%",
                  p: compact ? 0 : undefined,
                  px: compact ? 0 : 2.5,
                  py: compact ? 0 : 2,
                  overflow: "hidden",
                  border: `1px solid ${border}`,
                  borderRadius: "14px",
                  backgroundColor: surface,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  textAlign: "left",
                  transition: "all 0.25s cubic-bezier(0.4,0,0.2,1)",
                  boxShadow: isDark
                    ? "0 4px 16px rgba(0,0,0,0.3)"
                    : "0 4px 16px rgba(0,0,0,0.05)",
                  "&:hover": {
                    transform: "translateY(-2px)",
                    borderColor: alpha(accentRaw, 0.35),
                    boxShadow: isDark
                      ? `0 8px 28px rgba(0,0,0,0.45)`
                      : `0 8px 28px rgba(0,0,0,0.09)`,
                  },
                }}
              >
                {compact && (
                  <Box aria-hidden sx={{ position: "relative", borderBottom: `1px solid ${border}` }}>
                    {/* The reader's screens, toured (ReaderTour): what the demo opens on, moving */}
                    <ReaderTour height={128} />
                    <Box sx={{ position: "absolute", left: "50%", top: "45%", transform: "translate(-50%, -50%)", width: 46, height: 46, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", backgroundColor: alpha(accentRaw, 0.92), boxShadow: `0 10px 26px ${alpha(accentRaw, 0.45)}` }}>
                      <PlayArrowRoundedIcon sx={{ fontSize: 28 }} />
                    </Box>
                  </Box>
                )}
                {compact ? null : (
                <Box
                  sx={{
                    flexShrink: 0,
                    width: 44,
                    height: 44,
                    borderRadius: "12px",
                    background: isDark
                      ? `linear-gradient(135deg, ${alpha(accentRaw, 0.18)}, ${alpha(accentRaw, 0.08)})`
                      : `linear-gradient(135deg, ${alpha(accentRaw, 0.1)}, ${alpha(accentRaw, 0.04)})`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <PlayArrowRoundedIcon
                    sx={{ fontSize: 22, color: accentRaw }}
                  />
                </Box>
                )}
                <Box sx={{ flex: 1, minWidth: 0, ...(compact ? { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, px: 2, py: 1.4 } : {}) }}>
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: 700,
                      color: textPrimary,
                      fontSize: "0.88rem",
                      lineHeight: 1.3,
                    }}
                  >
                    {t("uploader.trySample")}
                  </Typography>
                  {compact && <ArrowForwardRoundedIcon aria-hidden sx={{ fontSize: 18, color: accentRaw }} />}
                  {!compact && (
                    <Typography
                      variant="caption"
                      sx={{
                        color: textSecondary,
                        fontSize: "0.74rem",
                        lineHeight: 1.4,
                        display: "block",
                      }}
                    >
                      {t("uploader.trySampleDesc")}
                    </Typography>
                  )}
                </Box>
              </Paper>
            <Button size="small" variant="text" startIcon={<FolderOpenOutlinedIcon />} onClick={handlePickProjectFile} aria-label={t("uploader.openProject.pickerLabel")} data-testid="backup-open" sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 700 }}>
              {t("backup.open")}
            </Button>
          </Box>
        )}
    </Box>
  );
}

export default GTFSUploader;
