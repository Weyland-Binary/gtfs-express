/**
 * Reads a GTFS file to explore (uploaded, validated, loaded; a feed with canonical errors lands on the repair
 * station) and loads the demo network. Home mounts it without its zone: its finder hands the file over here
 * (READ_GTFS_FILE_EVENT) so the read path stays this one.
 */

import React, { useEffect, useRef, useState } from "react";
import { Typography, Box, LinearProgress, Alert, Paper, useTheme, alpha } from "@mui/material";
import { useDropzone } from "react-dropzone";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import DirectionsBus from "@mui/icons-material/DirectionsBus";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import VerifiedIcon from "@mui/icons-material/Verified";
import { keyframes } from "@mui/system";
import API_BASE_URL from "../config";
import { fetchWithSession, newSessionId, sendWithSession, setSessionId } from "../utils/sessionManager";
import { beginOpening } from "../utils/networkOpening";
import { useLanguage } from "../contexts/LanguageContext";
import { useDestructiveGuard } from "../contexts/DestructiveGuardContext";
import { RULES_PATH, useNavigate } from "../utils/routes";
import { PICK_GTFS_FILE_EVENT, READ_GTFS_FILE_EVENT } from "../utils/appEvents";

/** Sent by Home's finder with { file } to read a GTFS file here. */

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

/** `inScreen`: the file's opening is shown by Home's computer screen (its bytes sent, the server's stages), not here. */
function GTFSUploader({ onUploadSuccess, onLoadSample, sampleError, compact = false, dropzone = true, inScreen = false }) {
  const baseUrl = API_BASE_URL;
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { guard } = useDestructiveGuard();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  const [uploading, setUploading] = useState(false);
  // Drives the phase message so the long silent step reads as normal and bounded, not an endless bar.
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

  const performUpload = async (file) => {
    const formData = new FormData();
    formData.append("gtfsZip", file);
    setUploading(true);
    setErrors(null);

    // Every file read here is a new network under a session of its own, adopted once the server holds it, so the
    // working copy open in this tab is never replaced by it.
    const fresh = newSessionId();
    const shown = inScreen ? beginOpening({ kind: "file", name: file.name, size: file.size }) : null;
    if (inScreen && !shown) {
      // Another network is opening in Home's screen: this file waits for it, said so.
      setUploading(false);
      setErrors([{ fileName: file.name, errors: [{ message: t("home.opening.busy") }] }]);
      return;
    }
    let adopted = false;
    try {
      // Both keep this X-Session-ID and turn HTTP 429 into a typed isRateLimit error (catch below).
      const response = shown
        ? await sendWithSession(`${baseUrl}/upload`, { method: "POST", body: formData, headers: { "X-Session-ID": fresh, ...shown.headers }, onSent: shown.sent })
        : await fetchWithSession(`${baseUrl}/upload`, {
            method: "POST",
            body: formData,
            headers: { "X-Session-ID": fresh },
          });

      // A gateway error answers HTML, not JSON.
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

      let result;
      try {
        const text = await response.text();
        try {
          result = JSON.parse(text);
        } catch {
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
        // Rows without GTFS-required fields, which the engine cannot load: say which file, line and field. It must
        // stay ahead of the generic `result.error` handling below, which would shadow it.
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
        if (result.error) {
          setErrors([
            {
              fileName: "⚠️ Error",
              errors: [
                {
                  line: "N/A",
                  field: "N/A",
                  // Middleware answers carry a human explanation in `message`.
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
          // A structural rejection: the backend created no session, so the app shows the full-screen report with
          // re-upload as the only exit. Feeds with canonical findings come back as 200 with a live session.
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
      setSessionId(fresh);
      adopted = true;
      shown?.finish();
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
      if (!adopted) shown?.end();
    }
  };

  // An upload ends the backend's edit session: unsaved edits are confirmed first.
  const onDrop = async (acceptedFiles) => {
    if (!acceptedFiles || acceptedFiles.length === 0) return;
    const file = acceptedFiles[0];
    guard(() => performUpload(file), { reason: "upload" });
  };

  const {
    getRootProps,
    getInputProps,
    open: openFilePicker,
  } = useDropzone({
    onDrop,
    accept: {
      "application/zip": [".zip"],
    },
    maxSize: 50 * 1024 * 1024,
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
      if (firstError?.code === "file-too-large") {
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
  useEffect(() => {
    const handler = () => {
      document.querySelector("[data-dropzone-anchor]")?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      openFilePicker();
    };
    window.addEventListener(PICK_GTFS_FILE_EVENT, handler);
    return () => window.removeEventListener(PICK_GTFS_FILE_EVENT, handler);
  }, [openFilePicker]);
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
  // The theme's secondary text reads 4.5:1 on the tinted cards too.
  const textSecondary = theme.palette.text.secondary;
  const accentRaw = isDark ? "#60a5fa" : "#3b82f6";

  const loadSample = () => {
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
  };

  return (
    <Box data-testid="explorer-card" sx={{ display: "flex", flexDirection: "column", width: "100%" }}>
        <Box
          data-dropzone-anchor
          sx={{
            mb: compact ? 0 : 1.25,
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
                borderRadius: "18px",
                p: { xs: 2, md: 2.25 },
                textAlign: "center",
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
                flexDirection="column"
                alignItems="center"
                justifyContent="center"
                gap={2}
              >
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

                <Box sx={{ minWidth: 0 }}>
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
                    sx={{ color: textSecondary, mb: 1, fontSize: "0.78rem" }}
                  >
                    {isDragActive
                      ? t("uploader.dropHintActive")
                      : t("uploader.dropHintIdle")}
                  </Typography>
                </Box>

                <Box
                  sx={{
                    display: "inline-flex",
                    flexWrap: "wrap",
                    justifyContent: "center",
                    alignItems: "center",
                    gap: 1,
                  }}
                >
                  <Box
                    sx={{
                      display: "inline-flex",
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

                  {/* The app's own rules page, which links to MobilityData's. */}
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
                    <Typography
                      variant="caption"
                      sx={{ color: textSecondary, display: "block", mt: 0.5 }}
                    >
                      {t("uploader.rescueHint")}
                    </Typography>
                  </Box>
                </Box>

              </Box>
            </Paper>
          )}

          {uploading && !inScreen && (
            <Paper
              elevation={0}
              sx={{
                p: compact ? 2 : 5,
                backgroundColor: surface,
                borderRadius: compact ? "14px" : "18px",
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
                gap={compact ? 1.25 : 2}
              >
                <Box display="flex" alignItems="center" gap={1}>
                  <DirectionsBus
                    sx={{
                      fontSize: compact ? 24 : 32,
                      color: accentRaw,
                      animation: `${bounceAnimation} 0.6s ease-in-out infinite`,
                    }}
                  />
                  <Typography
                    variant={compact ? "subtitle1" : "h6"}
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
        {!uploading && !loadingSample && (sampleError || !compact) && (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1, ...(compact ? { mt: 1 } : {}) }}>
            {sampleError && (
              <Alert severity="warning" sx={{ borderRadius: "12px" }}>
                {sampleError}
              </Alert>
            )}
              {compact ? null : (
              <Paper
                component="button"
                elevation={0}
                data-testid="uploader-load-sample"
                onClick={loadSample}
                sx={{
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 2,
                  width: "100%",
                  px: 2.5,
                  py: 2,
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
                <Box sx={{ flex: 1, minWidth: 0 }}>
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
                </Box>
              </Paper>
              )}
          </Box>
        )}
    </Box>
  );
}

export default GTFSUploader;
