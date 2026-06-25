import React, { useEffect, useRef, useState } from "react";
import {
  Container,
  Typography,
  Box,
  LinearProgress,
  Alert,
  Paper,
  Chip,
  IconButton,
  Tooltip,
  useTheme,
  alpha,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Dialog,
  Fade,
  Avatar,
  Stack,
} from "@mui/material";
import { useDropzone } from "react-dropzone";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import DirectionsBus from "@mui/icons-material/DirectionsBus";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import HistoryOutlinedIcon from "@mui/icons-material/HistoryOutlined";
import RestoreIcon from "@mui/icons-material/Restore";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ScheduleOutlinedIcon from "@mui/icons-material/ScheduleOutlined";
import MapOutlinedIcon from "@mui/icons-material/MapOutlined";
import TerminalIcon from "@mui/icons-material/Terminal";
import SecurityIcon from "@mui/icons-material/Security";
import CloudOffIcon from "@mui/icons-material/CloudOff";
import AutoDeleteIcon from "@mui/icons-material/AutoDelete";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import MailOutlineIcon from "@mui/icons-material/MailOutline";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ZoomInIcon from "@mui/icons-material/ZoomIn";
import CloseIcon from "@mui/icons-material/Close";
import AccountBalanceIcon from "@mui/icons-material/AccountBalance";
import EngineeringIcon from "@mui/icons-material/Engineering";
import DomainIcon from "@mui/icons-material/Domain";
import ArchitectureIcon from "@mui/icons-material/Architecture";
import DevicesIcon from "@mui/icons-material/Devices";
import ShieldOutlinedIcon from "@mui/icons-material/ShieldOutlined";
import VerifiedIcon from "@mui/icons-material/Verified";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import PersonIcon from "@mui/icons-material/Person";
import CodeIcon from "@mui/icons-material/Code";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import TableViewIcon from "@mui/icons-material/TableView";
import ReplayIcon from "@mui/icons-material/Replay";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { keyframes } from "@mui/system";
import API_BASE_URL from "../config";
import { fetchWithSession, resetSession } from "../utils/sessionManager";
import { useLanguage } from "../contexts/LanguageContext";
import { useEditMode } from "../contexts/EditModeContext";
import { useDestructiveGuard } from "../contexts/DestructiveGuardContext";
import {
  listSnapshots,
  getSnapshotBlob,
  deleteSnapshot,
} from "../utils/projectAutoSave";
import { PROJECT_EXT } from "../utils/projectFile";
import BetaGateDialog from "./edit/BetaGateDialog";
import GTFSAIIcon from "./chat/GTFSAIIcon";

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
    transform: translateY(-15px);
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

const fadeUp = keyframes`
  from { opacity: 0; transform: translateY(20px); }
  to   { opacity: 1; transform: translateY(0); }
`;

const scaleIn = keyframes`
  from { opacity: 0; transform: scale(0.94); }
  to   { opacity: 1; transform: scale(1); }
`;

function GTFSUploader({
  onUploadSuccess,
  onLoadSample,
  onProjectOpened,
  sampleError,
}) {
  const baseUrl = API_BASE_URL;
  const { t, language } = useLanguage();
  const { openProject } = useEditMode();
  const { guard } = useDestructiveGuard();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  // Real app screenshots. Order chosen: Schedules (daily density)
  // → Map (geo proof) → SQL (power-user proof). Colours aligned with the
  // FEATURES grid for implicit consistency between the two sections.
  const SHOWCASE_ITEMS = [
    {
      id: "schedule",
      Icon: ScheduleOutlinedIcon,
      eyebrowKey: "showcase.schedule.eyebrow",
      titleKey: "showcase.schedule.title",
      descKey: "showcase.schedule.desc",
      altKey: "showcase.schedule.alt",
      src: isDark
        ? "/img/Dark_Schedule_Grid.webp"
        : "/img/Light_Schedule_Grid.webp",
      color: "#10b981",
    },
    {
      id: "map",
      Icon: MapOutlinedIcon,
      eyebrowKey: "showcase.map.eyebrow",
      titleKey: "showcase.map.title",
      descKey: "showcase.map.desc",
      altKey: "showcase.map.alt",
      src: isDark ? "/img/Dark_Map.webp" : "/img/Light_Map.webp",
      color: "#f59e0b",
    },
    {
      id: "sql",
      Icon: TerminalIcon,
      eyebrowKey: "showcase.sql.eyebrow",
      titleKey: "showcase.sql.title",
      descKey: "showcase.sql.desc",
      altKey: "showcase.sql.alt",
      src: isDark
        ? "/img/Dark_SQL_Console.webp"
        : "/img/Light_SQL_Console.webp",
      color: "#8b5cf6",
    },
  ];

  const TRUST_ITEMS = [
    { icon: SecurityIcon, label: t("trust.security") },
    { icon: CloudOffIcon, label: t("trust.noCloud") },
    { icon: AutoDeleteIcon, label: t("trust.cleanup") },
  ];

  // Personas: who the workbench is built for. Migrated from the former
  // standalone Use Cases page so visitors recognize themselves on the home.
  // Click a card to expand its case-study blurb.
  const PERSONAS = [
    {
      Icon: AccountBalanceIcon,
      tag: "AOM",
      color: "#6366f1",
      label: t("useCases.persona0Label"),
      text: t("useCases.persona0Text"),
    },
    {
      Icon: DirectionsBus,
      tag: "OT",
      color: "#0ea5e9",
      label: t("useCases.persona1Label"),
      text: t("useCases.persona1Text"),
    },
    {
      Icon: EngineeringIcon,
      tag: "BET",
      color: "#f59e0b",
      label: t("useCases.persona2Label"),
      text: t("useCases.persona2Text"),
    },
    {
      Icon: DomainIcon,
      tag: "DSI",
      color: "#10b981",
      label: t("useCases.persona3Label"),
      text: t("useCases.persona3Text"),
    },
    {
      Icon: ArchitectureIcon,
      tag: "URB",
      color: "#ec4899",
      label: t("useCases.persona4Label"),
      text: t("useCases.persona4Text"),
    },
    {
      Icon: ShieldOutlinedIcon,
      tag: "DATA",
      color: "#8b5cf6",
      label: t("useCases.persona5Label"),
      text: t("useCases.persona5Text"),
    },
  ];

  // Security & sovereignty proof points: structured trust block migrated
  // from the former Use Cases page, kept distinct from the small ribbon
  // of TRUST_ITEMS at the very bottom of the home.
  const SECURITY_PROOFS = [
    {
      Icon: SecurityIcon,
      label: t("useCases.trust0Label"),
      sub: t("useCases.trust0Sub"),
    },
    {
      Icon: CloudOffIcon,
      label: t("useCases.trust1Label"),
      sub: t("useCases.trust1Sub"),
    },
    {
      Icon: AutoDeleteIcon,
      label: t("useCases.trust2Label"),
      sub: t("useCases.trust2Sub"),
    },
    {
      Icon: DevicesIcon,
      label: t("useCases.trust3Label"),
      sub: t("useCases.trust3Sub"),
    },
  ];

  const [uploading, setUploading] = useState(false);
  const [loadingSample, setLoadingSample] = useState(false);
  const [errors, setErrors] = useState(null);
  const [isDragActive, setIsDragActive] = useState(false);

  // ── Project (.gtfsproj): opening + IndexedDB snapshots ───────────────────
  // These states are isolated from the ZIP upload so that the two flows can
  // expose distinct progress messages ("Uploading 45%…" on the ZIP side,
  // "Opening project…" on the .gtfsproj side which includes validation + CSV dump).
  const [openingProject, setOpeningProject] = useState(false);
  const [openingProgress, setOpeningProgress] = useState(0);
  const [snapshots, setSnapshots] = useState([]);
  const [restoringSnapshotId, setRestoringSnapshotId] = useState(null);
  const projectInputRef = useRef(null);
  // Beta gate: if /edit/project/import returns 403, open the modal and
  // keep the file pending so we can retry with the typed code.
  const [betaGateOpen, setBetaGateOpen] = useState(false);
  const [betaGateInitialError, setBetaGateInitialError] = useState(null);
  const [pendingProjectFile, setPendingProjectFile] = useState(null);

  // Lightbox for the product showcase: clicking any of the 3 webp screenshots
  // opens a centered dialog that zooms the image to fit the viewport. ESC and
  // click-outside both close it.
  const [lightboxItem, setLightboxItem] = useState(null);
  // Personas section: one card may be expanded at a time to reveal its blurb.
  const [activePersona, setActivePersona] = useState(null);

  const refreshSnapshots = async () => {
    try {
      const rows = await listSnapshots();
      setSnapshots(rows);
    } catch (err) {
      console.warn("listSnapshots failed:", err);
      setSnapshots([]);
    }
  };

  useEffect(() => {
    refreshSnapshots();
  }, []);

  // Simple relative formatting, respects the language via Intl when available.
  const formatRelative = (ts) => {
    const diffMs = Date.now() - ts;
    const minutes = Math.round(diffMs / 60000);
    const hours = Math.round(diffMs / 3600000);
    const days = Math.round(diffMs / 86400000);
    try {
      const rtf = new Intl.RelativeTimeFormat(language || "fr", {
        numeric: "auto",
      });
      if (minutes < 60) return rtf.format(-minutes, "minute");
      if (hours < 24) return rtf.format(-hours, "hour");
      return rtf.format(-days, "day");
    } catch {
      if (minutes < 60) return `${minutes} min`;
      if (hours < 24) return `${hours} h`;
      return `${days} d`;
    }
  };

  const formatBytes = (n) => {
    if (!n || n <= 0) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };

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
          const result = await openProject(file, (p) => setOpeningProgress(p));
          if (result?.ok) {
            if (onProjectOpened) await onProjectOpened();
          } else if (
            result?.errorCode &&
            (result.errorCode.startsWith("BETA_") ||
              result.errorCode === "INVALID_BETA_CODE")
          ) {
            // Beta gate: open the modal, keep the file for retry.
            setPendingProjectFile(file);
            setBetaGateInitialError({
              code: result.errorCode,
              message: result.message,
            });
            setBetaGateOpen(true);
          }
        } finally {
          setOpeningProject(false);
          setOpeningProgress(0);
          if (projectInputRef.current) projectInputRef.current.value = "";
        }
      },
      { reason: "openProject" },
    );
  };

  /**
   * Submit handler for BetaGateDialog in the openProject flow.
   * Retries opening the pending file with the freshly entered code.
   */
  const handleBetaSubmitForOpenProject = async (code) => {
    if (!pendingProjectFile) {
      return { ok: false, errorCode: "INVALID_BETA_CODE" };
    }
    setOpeningProject(true);
    setOpeningProgress(0);
    try {
      const result = await openProject(
        pendingProjectFile,
        (p) => setOpeningProgress(p),
        code,
      );
      if (result?.ok) {
        setPendingProjectFile(null);
        if (onProjectOpened) await onProjectOpened();
        return { ok: true };
      }
      return {
        ok: false,
        errorCode: result?.errorCode || "INVALID_BETA_CODE",
        message: result?.message,
      };
    } finally {
      setOpeningProject(false);
      setOpeningProgress(0);
    }
  };

  const handlePickProjectFile = () => {
    if (projectInputRef.current) projectInputRef.current.click();
  };

  const handleRestoreSnapshot = async (snap) => {
    setRestoringSnapshotId(snap.id);
    try {
      const blob = await getSnapshotBlob(snap.id);
      if (!blob) {
        setErrors([
          {
            fileName: "⚠️ " + t("project.snapshotMissing"),
            errors: [{ message: t("project.snapshotMissing") }],
          },
        ]);
        return;
      }
      // IndexedDB stores a Blob; we promote it to a File to preserve a consistent
      // name on the backend side and in UX (Content-Disposition).
      const sourceName = (snap.meta && snap.meta.source_feed_name) || "project";
      const filename = `${sourceName}${PROJECT_EXT}`;
      const file = new File([blob], filename, {
        type: "application/octet-stream",
        lastModified: snap.ts || Date.now(),
      });
      await handleOpenProjectFile(file);
    } finally {
      setRestoringSnapshotId(null);
    }
  };

  const handleDeleteSnapshot = async (id) => {
    const confirmed = window.confirm(
      t("uploader.recentProjects.confirmDelete"),
    );
    if (!confirmed) return;
    await deleteSnapshot(id);
    refreshSnapshots();
  };

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
        // Autres erreurs
        if (result.error) {
          setErrors([
            {
              fileName: "⚠️ Error",
              errors: [
                {
                  line: "N/A",
                  field: "N/A",
                  message: result.error,
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
  const bg = isDark ? "#0a1929" : "#f5f7fa";
  const surface = isDark ? "#132f4c" : "#ffffff";
  const border = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)";
  const textPrimary = isDark ? "#ffffff" : "#1e293b";
  const textSecondary = isDark ? "#b0bec5" : "#64748b";
  const accent = isDark ? "#90caf9" : "#1976d2";
  const accentRaw = isDark ? "#60a5fa" : "#3b82f6";

  return (
    <Box
      sx={{
        background: bg,
        minHeight: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* ───── HERO ───── */}
      <Box
        sx={{
          background: isDark
            ? "linear-gradient(135deg, #0d2137 0%, #1a365d 50%, #0d2137 100%)"
            : "linear-gradient(135deg, #1e3a5f 0%, #1976d2 50%, #1565c0 100%)",
          pt: { xs: 2.5, md: 3 },
          pb: { xs: 3, md: 3.5 },
          px: 2,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Decorative circles */}
        <Box
          sx={{
            position: "absolute",
            width: 400,
            height: 400,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(255,255,255,0.04) 0%, transparent 70%)",
            top: -180,
            right: -80,
            pointerEvents: "none",
          }}
        />
        <Box
          sx={{
            position: "absolute",
            width: 260,
            height: 260,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(255,255,255,0.03) 0%, transparent 70%)",
            bottom: -120,
            left: -40,
            pointerEvents: "none",
          }}
        />

        <Container maxWidth="xl" sx={{ position: "relative", zIndex: 1 }}>
          <Box sx={{ maxWidth: 880 }}>
            <Chip
              icon={
                <DirectionsBus
                  sx={{
                    fontSize: "14px !important",
                    color: "rgba(255,255,255,0.8) !important",
                  }}
                />
              }
              label={t("hero.chip")}
              size="small"
              sx={{
                mb: 1.5,
                backgroundColor: "rgba(255,255,255,0.12)",
                color: "rgba(255,255,255,0.85)",
                fontWeight: 700,
                fontSize: "0.7rem",
                height: 24,
                letterSpacing: "0.04em",
                animation: `${fadeUp} 0.5s ease-out`,
              }}
            />
            <Typography
              variant="h3"
              component="h1"
              fontWeight={800}
              sx={{
                color: "#fff",
                fontSize: { xs: "1.4rem", sm: "1.7rem", md: "2rem" },
                lineHeight: 1.2,
                mb: 1.25,
                animation: `${fadeUp} 0.55s ease-out 0.05s both`,
                letterSpacing: "-0.02em",
              }}
            >
              {t("hero.titleBefore")}
              <Box
                component="span"
                sx={{
                  background: "linear-gradient(90deg, #90caf9, #ce93d8)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                }}
              >
                {t("hero.highlight")}
              </Box>
              {t("hero.titleAfter")}
              <Box component="br" />
              <Box
                component="span"
                sx={{ color: "rgba(255,255,255,0.78)", fontWeight: 600 }}
              >
                {t("hero.titleSecondLine")}
              </Box>
            </Typography>
            <Typography
              variant="body2"
              sx={{
                color: "rgba(255,255,255,0.65)",
                lineHeight: 1.55,
                fontSize: { xs: "0.82rem", md: "0.88rem" },
                maxWidth: 820,
                animation: `${fadeUp} 0.55s ease-out 0.1s both`,
              }}
            >
              {t("hero.subtitle")}
            </Typography>
            <Typography
              variant="body2"
              sx={{
                color: "rgba(255,255,255,0.55)",
                lineHeight: 1.55,
                fontSize: { xs: "0.78rem", md: "0.82rem" },
                maxWidth: 820,
                mt: 0.75,
                animation: `${fadeUp} 0.55s ease-out 0.15s both`,
              }}
            >
              {t("hero.subtitle2")}
            </Typography>
          </Box>
        </Container>
      </Box>

      <Container maxWidth="xl" sx={{ flex: 1 }}>
        {/* ───── DROPZONE (anchor for the Read mode "Try it now" CTA) ───── */}
        <Box
          data-dropzone-anchor
          sx={{
            mt: { xs: -3, md: -4 },
            mb: 2.5,
            maxWidth: 620,
            mx: "auto",
            position: "relative",
            zIndex: 2,
            animation: `${scaleIn} 0.5s ease-out 0.15s both`,
          }}
        >
          {!uploading && (
            <Paper
              elevation={0}
              {...getRootProps()}
              sx={{
                position: "relative",
                overflow: "hidden",
                border: `2px dashed ${isDragActive ? accentRaw : border}`,
                borderRadius: "18px",
                p: { xs: 4, md: 5 },
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
              <input {...getInputProps()} />

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
                flexDirection="column"
                alignItems="center"
                justifyContent="center"
                gap={2}
              >
                {/* Icon container */}
                <Box
                  sx={{
                    width: 72,
                    height: 72,
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
                      fontSize: 36,
                      color: accentRaw,
                      filter: isDragActive
                        ? `drop-shadow(0 0 8px ${alpha(accentRaw, 0.5)})`
                        : "none",
                    }}
                  />
                </Box>

                <Box>
                  <Typography
                    variant="h6"
                    fontWeight={700}
                    sx={{
                      color: isDragActive ? accentRaw : textPrimary,
                      mb: 0.5,
                      transition: "color 0.3s ease",
                      fontSize: "1.05rem",
                    }}
                  >
                    {isDragActive
                      ? t("uploader.dropActive")
                      : t("uploader.dropIdle")}
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{ color: textSecondary, mb: 2 }}
                  >
                    {isDragActive
                      ? t("uploader.dropHintActive")
                      : t("uploader.dropHintIdle")}
                  </Typography>
                </Box>

                {/* File specs + validator pills */}
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

                  <Box
                    component="a"
                    href="https://gtfs-validator.mobilitydata.org/rules.html"
                    target="_blank"
                    rel="noopener noreferrer"
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
                  </Box>
                </Box>

                {/* Decorative dots */}
                {!isDragActive && (
                  <Box
                    sx={{
                      display: { xs: "none", md: "flex" },
                      gap: 1,
                      mt: 0.5,
                      opacity: 0.5,
                    }}
                  >
                    {[...Array(3)].map((_, i) => (
                      <Box
                        key={i}
                        sx={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          backgroundColor: accentRaw,
                          animation: `${pulseAnimation} 2s ease-in-out infinite`,
                          animationDelay: `${i * 0.3}s`,
                        }}
                      />
                    ))}
                  </Box>
                )}
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
                <Typography variant="caption" sx={{ color: textSecondary }}>
                  {t("uploader.processingDesc")}
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

        {/* ───── SECONDARY ACTIONS: Open project + Try sample ───── */}
        {!uploading && !openingProject && !loadingSample && (
          <Box
            sx={{
              mb: 4,
              maxWidth: 620,
              mx: "auto",
              animation: `${fadeUp} 0.5s ease-out 0.25s both`,
            }}
          >
            {/* "or" divider */}
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 2,
                mb: 2.5,
                maxWidth: 280,
                mx: "auto",
              }}
            >
              <Box sx={{ flex: 1, height: "1px", backgroundColor: border }} />
              <Typography
                variant="caption"
                sx={{
                  color: textSecondary,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  fontSize: "0.68rem",
                }}
              >
                {t("uploader.or")}
              </Typography>
              <Box sx={{ flex: 1, height: "1px", backgroundColor: border }} />
            </Box>

            {sampleError && (
              <Alert severity="warning" sx={{ mb: 2, borderRadius: "12px" }}>
                {sampleError}
              </Alert>
            )}

            {/* Two tiles side by side: "Open a project" + "Try the sample".
                Intended design: visual parity, so that "Open a project" is not
                perceived as a mere secondary link — it is a true first-class flow. */}
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
                gap: 2,
              }}
            >
              {/* Tile: Open a project (.gtfsproj) */}
              <Paper
                component="button"
                elevation={0}
                onClick={handlePickProjectFile}
                aria-label={t("uploader.openProject.pickerLabel")}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 2,
                  width: "100%",
                  px: 2.5,
                  py: 2,
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
                  <FolderOpenOutlinedIcon
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
                    {t("uploader.openProject.title")}
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
                    {t("uploader.openProject.desc")}
                  </Typography>
                </Box>
              </Paper>

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
                  alignItems: "center",
                  gap: 2,
                  width: "100%",
                  px: 2.5,
                  py: 2,
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
            </Box>
          </Box>
        )}

        {/* ───── RECENT PROJECTS (IndexedDB snapshots) ───── */}
        {!uploading && !openingProject && snapshots.length > 0 && (
          <Paper
            elevation={0}
            sx={{
              mb: 5,
              maxWidth: 620,
              mx: "auto",
              p: 2.5,
              border: `1px solid ${border}`,
              borderRadius: "14px",
              backgroundColor: surface,
              boxShadow: isDark
                ? "0 4px 16px rgba(0,0,0,0.3)"
                : "0 4px 16px rgba(0,0,0,0.05)",
              animation: `${fadeUp} 0.5s ease-out 0.35s both`,
            }}
          >
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                mb: 1.5,
              }}
            >
              <HistoryOutlinedIcon
                sx={{ fontSize: 18, color: textSecondary }}
              />
              <Typography
                variant="subtitle2"
                sx={{
                  color: textPrimary,
                  fontWeight: 700,
                  fontSize: "0.85rem",
                }}
              >
                {t("uploader.recentProjects.title")}
              </Typography>
            </Box>
            <Typography
              variant="caption"
              sx={{
                display: "block",
                color: textSecondary,
                mb: 1.5,
                fontSize: "0.72rem",
                lineHeight: 1.5,
              }}
            >
              {t("uploader.recentProjects.desc")}
            </Typography>

            <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
              {snapshots.map((snap) => {
                const sourceName =
                  (snap.meta && snap.meta.source_feed_name) ||
                  t("project.untitled");
                const sizeLabel = formatBytes(snap.size);
                const relLabel = formatRelative(snap.ts);
                const isRestoring = restoringSnapshotId === snap.id;
                return (
                  <Box
                    key={snap.id}
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1.5,
                      px: 1.5,
                      py: 1,
                      borderRadius: "10px",
                      border: `1px solid ${border}`,
                      backgroundColor: isDark
                        ? alpha("#fff", 0.02)
                        : alpha("#000", 0.015),
                      transition: "background-color 0.15s ease",
                      "&:hover": {
                        backgroundColor: isDark
                          ? alpha("#fff", 0.04)
                          : alpha("#000", 0.03),
                      },
                    }}
                  >
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography
                        variant="body2"
                        sx={{
                          fontWeight: 600,
                          color: textPrimary,
                          fontSize: "0.82rem",
                          lineHeight: 1.3,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={sourceName}
                      >
                        {sourceName}
                      </Typography>
                      <Typography
                        variant="caption"
                        sx={{
                          color: textSecondary,
                          fontSize: "0.7rem",
                          lineHeight: 1.4,
                        }}
                      >
                        {t("uploader.recentProjects.relativeAgo", {
                          time: relLabel,
                        })}
                        {sizeLabel ? ` · ${sizeLabel}` : ""}
                      </Typography>
                    </Box>
                    <Tooltip title={t("buttons.restore") || "Restore"}>
                      <span>
                        <IconButton
                          size="small"
                          onClick={() => handleRestoreSnapshot(snap)}
                          disabled={isRestoring || openingProject}
                          aria-label={t("buttons.restore") || "Restore"}
                          sx={{ color: accentRaw }}
                        >
                          <RestoreIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title={t("buttons.delete") || "Delete"}>
                      <span>
                        <IconButton
                          size="small"
                          onClick={() => handleDeleteSnapshot(snap.id)}
                          disabled={isRestoring}
                          aria-label={t("buttons.delete") || "Delete"}
                          sx={{ color: textSecondary }}
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Box>
                );
              })}
            </Box>
          </Paper>
        )}

        {/* ───── PRODUCT SHOWCASE — visual proof above the text grid ───── */}
        <Box sx={{ mb: 6 }}>
          <Box sx={{ textAlign: "center", mb: 4 }}>
            <Chip
              icon={
                <VisibilityOutlinedIcon sx={{ fontSize: "14px !important" }} />
              }
              label={t("showcase.chip")}
              size="small"
              sx={{
                mb: 1.5,
                backgroundColor: alpha(accent, isDark ? 0.15 : 0.08),
                color: accent,
                fontWeight: 600,
                fontSize: "0.7rem",
              }}
            />
            <Typography
              variant="h5"
              fontWeight={800}
              sx={{
                color: textPrimary,
                fontSize: { xs: "1.15rem", md: "1.4rem" },
                letterSpacing: "-0.01em",
                mb: 0.75,
              }}
            >
              {t("showcase.title")}
            </Typography>
            <Typography
              variant="body2"
              sx={{
                color: textSecondary,
                fontSize: { xs: "0.82rem", md: "0.88rem" },
                maxWidth: 520,
                mx: "auto",
              }}
            >
              {t("showcase.subtitle")}
            </Typography>
          </Box>

          {/* Three alternating image/text rows. On mobile: image above,
              text below (always in this order, never reversed). */}
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              gap: { xs: 4, md: 5 },
            }}
          >
            {SHOWCASE_ITEMS.map(
              (
                { id, Icon, eyebrowKey, titleKey, descKey, altKey, src, color },
                i,
              ) => {
                const reverse = i % 2 === 1;
                return (
                  <Box
                    key={id}
                    sx={{
                      display: "grid",
                      gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
                      gap: { xs: 2.5, md: 5 },
                      alignItems: "center",
                      animation: `${fadeUp} 0.5s ease-out ${0.1 * i}s both`,
                    }}
                  >
                    {/* Image — Paper wrapper for frame + shadow + clip overflow.
                        Click on the image opens the full-screen lightbox. */}
                    <Paper
                      elevation={0}
                      role="button"
                      tabIndex={0}
                      aria-label={t("showcase.zoomHint")}
                      onClick={() =>
                        setLightboxItem({
                          src,
                          alt: t(altKey),
                          title: t(titleKey),
                          eyebrow: t(eyebrowKey),
                          color,
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setLightboxItem({
                            src,
                            alt: t(altKey),
                            title: t(titleKey),
                            eyebrow: t(eyebrowKey),
                            color,
                          });
                        }
                      }}
                      sx={{
                        order: { xs: 0, md: reverse ? 2 : 0 },
                        overflow: "hidden",
                        borderRadius: "14px",
                        border: `1px solid ${border}`,
                        backgroundColor: isDark
                          ? alpha("#000", 0.25)
                          : alpha("#0f172a", 0.02),
                        boxShadow: isDark
                          ? "0 12px 32px rgba(0,0,0,0.45)"
                          : "0 12px 32px rgba(15,23,42,0.08)",
                        cursor: "zoom-in",
                        position: "relative",
                        transition:
                          "transform 0.25s cubic-bezier(0.4,0,0.2,1), box-shadow 0.25s cubic-bezier(0.4,0,0.2,1), border-color 0.25s cubic-bezier(0.4,0,0.2,1)",
                        "&:hover": {
                          transform: "translateY(-4px)",
                          borderColor: alpha(color, 0.4),
                          boxShadow: isDark
                            ? `0 20px 44px rgba(0,0,0,0.55)`
                            : `0 20px 44px ${alpha(color, 0.18)}`,
                        },
                        "&:hover .zoom-overlay": {
                          opacity: 1,
                        },
                        "&:focus-visible": {
                          outline: `2px solid ${color}`,
                          outlineOffset: 2,
                        },
                      }}
                    >
                      <Box
                        component="img"
                        src={src}
                        alt={t(altKey)}
                        loading="lazy"
                        decoding="async"
                        sx={{
                          width: "100%",
                          height: "auto",
                          display: "block",
                          maxHeight: { xs: 260, sm: 340, md: 440 },
                          objectFit: "contain",
                        }}
                      />
                      <Box
                        className="zoom-overlay"
                        sx={{
                          position: "absolute",
                          top: 10,
                          right: 10,
                          width: 36,
                          height: 36,
                          borderRadius: "50%",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          backgroundColor: "rgba(15,23,42,0.72)",
                          color: "#fff",
                          opacity: 0,
                          transition: "opacity 0.2s ease",
                          backdropFilter: "blur(4px)",
                          pointerEvents: "none",
                        }}
                      >
                        <ZoomInIcon sx={{ fontSize: 20 }} />
                      </Box>
                    </Paper>

                    {/* Text block */}
                    <Box sx={{ minWidth: 0 }}>
                      <Box
                        sx={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 0.75,
                          px: 1.25,
                          py: 0.5,
                          borderRadius: "8px",
                          backgroundColor: alpha(color, isDark ? 0.18 : 0.1),
                          mb: 1.25,
                        }}
                      >
                        <Icon sx={{ fontSize: 14, color }} />
                        <Typography
                          variant="caption"
                          sx={{
                            color,
                            fontWeight: 700,
                            fontSize: "0.68rem",
                            letterSpacing: "0.08em",
                            textTransform: "uppercase",
                          }}
                        >
                          {t(eyebrowKey)}
                        </Typography>
                      </Box>
                      <Typography
                        variant="h6"
                        fontWeight={800}
                        sx={{
                          color: textPrimary,
                          fontSize: { xs: "1rem", md: "1.15rem" },
                          letterSpacing: "-0.01em",
                          lineHeight: 1.25,
                          mb: 1.25,
                        }}
                      >
                        {t(titleKey)}
                      </Typography>
                      <Typography
                        variant="body2"
                        sx={{
                          color: textSecondary,
                          fontSize: { xs: "0.82rem", md: "0.88rem" },
                          lineHeight: 1.6,
                        }}
                      >
                        {t(descKey)}
                      </Typography>
                    </Box>
                  </Box>
                );
              },
            )}
          </Box>
        </Box>

        {/* ───── AI ASSISTANT — dedicated highlight section ───── */}
        <Box
          sx={{
            mb: 8,
            mt: 2,
            py: { xs: 5, md: 8 },
            px: { xs: 2, md: 4 },
            borderRadius: "28px",
            background: isDark
              ? `linear-gradient(160deg, #0e0b1f 0%, #130a2c 100%)`
              : `linear-gradient(160deg, #f5f1ff 0%, #ede8ff 100%)`,
            border: `1px solid ${alpha("#6366f1", isDark ? 0.25 : 0.14)}`,
            boxShadow: isDark
              ? `0 0 80px ${alpha("#6366f1", 0.12)}, inset 0 1px 0 ${alpha("#ffffff", 0.04)}`
              : `0 0 50px ${alpha("#6366f1", 0.08)}, 0 2px 4px ${alpha("#6366f1", 0.05)}`,
            position: "relative",
            overflow: "hidden",
          }}
        >
          {/* Decorative background blobs — very large + low opacity for smooth ambient glow */}
          <Box
            aria-hidden
            sx={{
              position: "absolute",
              top: "-30%",
              left: "-15%",
              width: 700,
              height: 700,
              borderRadius: "50%",
              background: `radial-gradient(circle, ${alpha("#7c3aed", isDark ? 0.18 : 0.10)} 0%, transparent 65%)`,
              pointerEvents: "none",
            }}
          />
          <Box
            aria-hidden
            sx={{
              position: "absolute",
              bottom: "-35%",
              right: "-15%",
              width: 680,
              height: 680,
              borderRadius: "50%",
              background: `radial-gradient(circle, ${alpha("#4f46e5", isDark ? 0.14 : 0.08)} 0%, transparent 65%)`,
              pointerEvents: "none",
            }}
          />
          <Box
            aria-hidden
            sx={{
              position: "absolute",
              top: "15%",
              left: "40%",
              width: 500,
              height: 500,
              borderRadius: "50%",
              background: `radial-gradient(circle, ${alpha("#818cf8", isDark ? 0.09 : 0.06)} 0%, transparent 65%)`,
              pointerEvents: "none",
            }}
          />

          {/* Content sits above the decorative layer */}
          <Box sx={{ position: "relative", zIndex: 1 }}>
          <Box sx={{ textAlign: "center", mb: 4 }}>
            <Chip
              icon={<GTFSAIIcon sx={{ fontSize: "13px !important" }} />}
              label={t("ai.eyebrow")}
              size="small"
              sx={{
                mb: 2,
                background: isDark
                  ? `linear-gradient(135deg, ${alpha("#7c3aed", 0.55)}, ${alpha("#6366f1", 0.45)})`
                  : `linear-gradient(135deg, ${alpha("#7c3aed", 0.18)}, ${alpha("#6366f1", 0.14)})`,
                border: `1px solid ${alpha("#6366f1", isDark ? 0.50 : 0.30)}`,
                color: isDark ? "#c4b5fd" : "#4f46e5",
                fontWeight: 700,
                fontSize: "0.7rem",
                letterSpacing: "0.03em",
                backdropFilter: "blur(4px)",
                "& .MuiChip-icon": { color: "inherit" },
              }}
            />
            <Typography
              variant="h4"
              fontWeight={900}
              sx={{
                fontSize: { xs: "1.55rem", md: "2.1rem" },
                letterSpacing: "-0.025em",
                mb: 1,
                background: isDark
                  ? `linear-gradient(135deg, #c4b5fd 0%, #818cf8 60%, #a5b4fc 100%)`
                  : `linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%)`,
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}
            >
              {t("ai.title")}
            </Typography>
            <Typography
              variant="body2"
              sx={{
                color: isDark ? alpha("#e0d9ff", 0.75) : alpha("#3b0764", 0.70),
                fontSize: { xs: "0.88rem", md: "0.96rem" },
                maxWidth: 600,
                mx: "auto",
                lineHeight: 1.6,
              }}
            >
              {t("ai.subtitle")}
            </Typography>
          </Box>

          {/* Mock conversation — pixel-faithful reproduction of the real
              chat UI (UserBubble + AssistantBubble + SqlAccordion expanded
              + ResultTablePreview + action toolbar). Built from raw boxes
              rather than reusing the actual chat components to keep this
              section self-contained (no chat contexts, no real handlers). */}
          <Paper
            elevation={0}
            sx={{
              maxWidth: 900,
              mx: "auto",
              p: { xs: 1.5, md: 2.25 },
              borderRadius: "18px",
              border: `1px solid ${alpha("#6366f1", isDark ? 0.38 : 0.15)}`,
              background: isDark
                ? `linear-gradient(160deg, ${alpha("#1e1040", 0.95)} 0%, ${alpha("#0f0a20", 0.98)} 65%)`
                : `linear-gradient(160deg, #ffffff 0%, #fafafe 100%)`,
              boxShadow: isDark
                ? `0 20px 60px ${alpha("#000", 0.55)}, 0 4px 16px ${alpha("#6366f1", 0.18)}, inset 0 1px 0 ${alpha("#fff", 0.05)}`
                : `0 20px 60px ${alpha("#4f46e5", 0.14)}, 0 4px 16px rgba(0,0,0,0.06)`,
              animation: `${fadeUp} 0.6s ease-out 0.1s both`,
              position: "relative",
              overflow: "hidden",
            }}
          >
            {/* Decorative violet glow in top-right corner */}
            <Box
              aria-hidden
              sx={{
                position: "absolute",
                top: -70,
                right: -50,
                width: 220,
                height: 220,
                borderRadius: "50%",
                background: `radial-gradient(circle, ${alpha("#7c3aed", isDark ? 0.20 : 0.10)} 0%, transparent 70%)`,
                pointerEvents: "none",
              }}
            />

            {/* ── USER BUBBLE ── mirrors src/components/chat/MessageBubble.js
                  UserBubble: row-reverse, 88% max-width, 26×26 PersonIcon
                  avatar + primary-gradient bubble with reduced top-right
                  radius. */}
            <Box
              sx={{
                display: "flex",
                flexDirection: "row-reverse",
                alignItems: "flex-start",
                gap: 1,
                maxWidth: "88%",
                ml: "auto",
                mb: 1.5,
                position: "relative",
              }}
            >
              <Avatar
                sx={{
                  width: 26,
                  height: 26,
                  mt: 0.25,
                  bgcolor: alpha(theme.palette.primary.main, 0.15),
                  color: theme.palette.primary.main,
                  flexShrink: 0,
                }}
              >
                <PersonIcon sx={{ fontSize: 16 }} />
              </Avatar>
              <Box
                sx={{
                  background: `linear-gradient(135deg, ${theme.palette.primary.main} 0%, ${alpha(theme.palette.primary.dark, 0.95)} 100%)`,
                  color: theme.palette.primary.contrastText,
                  px: 1.5,
                  py: 0.95,
                  borderRadius: 2,
                  borderTopRightRadius: 0.5,
                  fontSize: "0.85rem",
                  lineHeight: 1.45,
                  boxShadow: `0 1px 3px ${alpha(theme.palette.primary.main, 0.30)}`,
                }}
              >
                {t("ai.mockQuestion")}
              </Box>
            </Box>

            {/* ── ASSISTANT BUBBLE ── 26×26 indigo-gradient avatar + content
                  wrapper that hosts: prose · SqlAccordion (expanded) ·
                  ResultTablePreview · action toolbar. Styling mirrors
                  MessageBubble.js AssistantBubble. */}
            <Box
              sx={{
                display: "flex",
                gap: 1,
                maxWidth: "98%",
                width: "100%",
                position: "relative",
              }}
            >
              <Avatar
                sx={{
                  width: 26,
                  height: 26,
                  mt: 0.25,
                  background: `linear-gradient(135deg, #7c3aed 0%, #6366f1 100%)`,
                  color: "#fff",
                  flexShrink: 0,
                  boxShadow: `0 2px 6px ${alpha("#6366f1", 0.30)}`,
                }}
              >
                <GTFSAIIcon sx={{ fontSize: 15 }} />
              </Avatar>
              <Box
                sx={{
                  flex: 1,
                  minWidth: 0,
                  background: alpha(theme.palette.background.default, 0.6),
                  backgroundImage: isDark
                    ? `linear-gradient(180deg, ${alpha("#fff", 0.025)}, ${alpha("#fff", 0.01)})`
                    : `linear-gradient(180deg, ${alpha("#000", 0.018)}, ${alpha("#000", 0.005)})`,
                  border: `1px solid ${alpha(theme.palette.text.primary, 0.08)}`,
                  borderRadius: 2,
                  borderTopLeftRadius: 0.5,
                  px: 1.5,
                  py: 1.1,
                }}
              >
                {/* Prose answer */}
                <Box
                  sx={{
                    fontSize: "0.85rem",
                    lineHeight: 1.5,
                    color: "text.primary",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {t("ai.mockAnswer")}
                </Box>

                {/* ── SQL ACCORDION (expanded) ── mirrors SqlAccordion.js.
                      Header: code icon + SELECT chip + char count + copy +
                      expand arrow rotated 180°. Body: indented colorized
                      SQL using theme.palette.primary.main for keywords. */}
                <Box
                  sx={{
                    mt: 1,
                    borderRadius: 1.5,
                    overflow: "hidden",
                    border: `1px solid ${alpha(theme.palette.text.primary, 0.10)}`,
                    background: alpha(theme.palette.text.primary, 0.04),
                  }}
                >
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      px: 1.25,
                      py: 0.65,
                      background: alpha(theme.palette.text.primary, 0.06),
                    }}
                  >
                    <CodeIcon sx={{ fontSize: 14, color: "text.secondary", flexShrink: 0 }} />
                    <Chip
                      label="SELECT"
                      size="small"
                      sx={{
                        height: 18,
                        fontSize: "0.62rem",
                        fontWeight: 700,
                        letterSpacing: 0.4,
                        color: "#fff",
                        bgcolor: theme.palette.info.main,
                        "& .MuiChip-label": { px: 0.85 },
                      }}
                    />
                    <Box
                      sx={{
                        ml: 0.5,
                        fontSize: "0.68rem",
                        color: "text.disabled",
                        fontFamily:
                          "ui-monospace, 'SF Mono', Consolas, Monaco, monospace",
                        flex: 1,
                      }}
                    >
                      253 chars
                    </Box>
                    <ContentCopyIcon
                      sx={{ fontSize: 13, color: "text.secondary", opacity: 0.6 }}
                    />
                    <ExpandMoreIcon
                      sx={{
                        fontSize: 16,
                        color: "text.secondary",
                        transform: "rotate(180deg)",
                      }}
                    />
                  </Box>
                  <Box
                    sx={{
                      px: 1.5,
                      py: 1.1,
                      fontFamily:
                        "ui-monospace, 'SF Mono', Consolas, Monaco, 'Courier New', monospace",
                      fontSize: { xs: "0.70rem", md: "0.74rem" },
                      lineHeight: 1.55,
                      whiteSpace: "pre",
                      overflowX: "auto",
                      color: "text.primary",
                    }}
                  >
                    {(() => {
                      const kw = {
                        color: theme.palette.primary.main,
                        fontWeight: 700,
                      };
                      return (
                        <>
                          <Box component="span" sx={kw}>SELECT</Box> s.stop_id, s.stop_name,
                          {"\n       "}
                          <Box component="span" sx={kw}>COUNT</Box>(<Box component="span" sx={kw}>DISTINCT</Box> r.route_id) <Box component="span" sx={kw}>AS</Box> routes
                          {"\n"}
                          <Box component="span" sx={kw}>FROM</Box> stops s
                          {"\n"}
                          <Box component="span" sx={kw}>JOIN</Box> stop_times st <Box component="span" sx={kw}>ON</Box> st.stop_id = s.stop_id
                          {"\n"}
                          <Box component="span" sx={kw}>JOIN</Box> trips t <Box component="span" sx={kw}>ON</Box> t.trip_id = st.trip_id
                          {"\n"}
                          <Box component="span" sx={kw}>JOIN</Box> routes r <Box component="span" sx={kw}>ON</Box> r.route_id = t.route_id
                          {"\n"}
                          <Box component="span" sx={kw}>GROUP BY</Box> s.stop_id, s.stop_name
                          {"\n"}
                          <Box component="span" sx={kw}>ORDER BY</Box> routes <Box component="span" sx={kw}>DESC</Box>
                          {"\n"}
                          <Box component="span" sx={kw}>LIMIT</Box> <Box component="span" sx={{ color: theme.palette.warning.main }}>5</Box>;
                        </>
                      );
                    })()}
                  </Box>
                </Box>

                {/* ── RESULT TABLE PREVIEW ── mirrors ResultTablePreview.js.
                      Stat strip (icon + row count chip + col chip + duration
                      chip + open-in-console button) then a sticky thead +
                      tbody with zebra striping. */}
                <Box
                  sx={{
                    mt: 1,
                    borderRadius: 1.5,
                    overflow: "hidden",
                    border: `1px solid ${alpha(theme.palette.text.primary, 0.10)}`,
                    background: theme.palette.background.paper,
                  }}
                >
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 0.75,
                      px: 1.25,
                      py: 0.65,
                      background: alpha(theme.palette.text.primary, 0.06),
                      borderBottom: `1px solid ${alpha(theme.palette.text.primary, 0.10)}`,
                    }}
                  >
                    <TableViewIcon
                      sx={{ fontSize: 14, color: "text.secondary", flexShrink: 0 }}
                    />
                    <Chip
                      label={t("chat.result.rowCount", { count: 5 })}
                      size="small"
                      sx={{
                        height: 18,
                        fontSize: "0.62rem",
                        fontWeight: 700,
                        color: theme.palette.info.main,
                        bgcolor: alpha(theme.palette.info.main, 0.12),
                        "& .MuiChip-label": { px: 0.85 },
                      }}
                    />
                    <Chip
                      label={t("chat.result.colCount", { count: 3 })}
                      size="small"
                      sx={{
                        height: 18,
                        fontSize: "0.62rem",
                        color: "text.secondary",
                        bgcolor: alpha(theme.palette.text.primary, 0.06),
                        "& .MuiChip-label": { px: 0.85 },
                      }}
                    />
                    <Chip
                      label="3 ms"
                      size="small"
                      variant="outlined"
                      sx={{
                        height: 18,
                        fontSize: "0.6rem",
                        color: "text.disabled",
                        borderColor: alpha(theme.palette.text.primary, 0.15),
                        "& .MuiChip-label": { px: 0.7 },
                      }}
                    />
                    <Box sx={{ flex: 1 }} />
                    <OpenInNewIcon
                      sx={{ fontSize: 13, color: "text.secondary", opacity: 0.6 }}
                    />
                  </Box>
                  <Box
                    sx={{
                      maxHeight: 220,
                      overflow: "auto",
                    }}
                  >
                    <Box
                      component="table"
                      sx={{
                        width: "100%",
                        borderCollapse: "separate",
                        borderSpacing: 0,
                        fontFamily:
                          "ui-monospace, 'SF Mono', Consolas, Monaco, monospace",
                        fontSize: "0.7rem",
                      }}
                    >
                      <Box component="thead">
                        <Box component="tr">
                          {["stop_id", "stop_name", "routes"].map((c) => (
                            <Box
                              key={c}
                              component="th"
                              sx={{
                                textAlign: "left",
                                px: 1,
                                py: 0.6,
                                background: alpha(theme.palette.text.primary, 0.06),
                                borderBottom: `1px solid ${alpha(theme.palette.text.primary, 0.10)}`,
                                fontWeight: 700,
                                color: "text.primary",
                                whiteSpace: "nowrap",
                                fontSize: "0.66rem",
                                letterSpacing: 0.2,
                              }}
                            >
                              {c}
                            </Box>
                          ))}
                        </Box>
                      </Box>
                      <Box component="tbody">
                        {[
                          ["s_042", "Central Station", "22"],
                          ["s_103", "Airport", "18"],
                          ["s_067", "City Hall", "15"],
                          ["s_211", "University", "13"],
                          ["s_089", "Stadium", "11"],
                        ].map((row, rIdx) => (
                          <Box
                            key={rIdx}
                            component="tr"
                            sx={{
                              background:
                                rIdx % 2 === 1
                                  ? alpha(theme.palette.text.primary, 0.025)
                                  : "transparent",
                            }}
                          >
                            {row.map((cell, cIdx) => (
                              <Box
                                key={cIdx}
                                component="td"
                                sx={{
                                  px: 1,
                                  py: 0.5,
                                  borderBottom: `1px solid ${alpha(theme.palette.text.primary, 0.06)}`,
                                  color: "text.primary",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {cell}
                              </Box>
                            ))}
                          </Box>
                        ))}
                      </Box>
                    </Box>
                  </Box>
                </Box>

                {/* ── ACTION TOOLBAR ── 3 disabled icon buttons (open in
                      console, copy, regenerate) — visual only since this is
                      a static mock. */}
                <Stack
                  direction="row"
                  spacing={0.5}
                  sx={{ mt: 0.85, justifyContent: "flex-end" }}
                >
                  <Box
                    sx={{
                      width: 24,
                      height: 24,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: "50%",
                      color: "text.secondary",
                      opacity: 0.55,
                    }}
                  >
                    <OpenInNewIcon sx={{ fontSize: 13 }} />
                  </Box>
                  <Box
                    sx={{
                      width: 24,
                      height: 24,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: "50%",
                      color: "text.secondary",
                      opacity: 0.55,
                    }}
                  >
                    <ContentCopyIcon sx={{ fontSize: 13 }} />
                  </Box>
                  <Box
                    sx={{
                      width: 24,
                      height: 24,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: "50%",
                      color: "text.secondary",
                      opacity: 0.55,
                    }}
                  >
                    <ReplayIcon sx={{ fontSize: 13 }} />
                  </Box>
                </Stack>
              </Box>
            </Box>
          </Paper>

          {/* Example queries — non-interactive chips that hint at the
              breadth of what the assistant can do. */}
          <Box sx={{ mt: 3, textAlign: "center" }}>
            <Typography
              variant="caption"
              sx={{
                color: isDark ? alpha("#c4b5fd", 0.65) : alpha("#5b21b6", 0.65),
                fontSize: "0.74rem",
                display: "block",
                mb: 1.25,
                fontStyle: "italic",
              }}
            >
              {t("ai.examplesLabel")}
            </Typography>
            <Box
              sx={{
                display: "flex",
                flexWrap: "wrap",
                gap: 1,
                justifyContent: "center",
                maxWidth: 720,
                mx: "auto",
              }}
            >
              {[t("ai.example1"), t("ai.example2"), t("ai.example3")].map((ex) => (
                <Box
                  key={ex}
                  sx={{
                    px: 1.5,
                    py: 0.75,
                    borderRadius: "999px",
                    border: `1px solid ${alpha("#6366f1", isDark ? 0.40 : 0.28)}`,
                    backgroundColor: isDark ? alpha("#6366f1", 0.12) : alpha("#fff", 0.65),
                    color: isDark ? "#a5b4fc" : "#4f46e5",
                    fontSize: "0.74rem",
                    fontWeight: 500,
                    cursor: "default",
                    backdropFilter: "blur(4px)",
                    transition: "all 0.18s ease",
                    "&:hover": {
                      borderColor: alpha("#6366f1", isDark ? 0.60 : 0.45),
                      backgroundColor: isDark ? alpha("#6366f1", 0.18) : alpha("#fff", 0.90),
                      transform: "translateY(-1px)",
                    },
                  }}
                >
                  {ex}
                </Box>
              ))}
            </Box>
            <Typography
              variant="caption"
              sx={{
                display: "block",
                mt: 2,
                color: isDark ? alpha("#c4b5fd", 0.50) : alpha("#5b21b6", 0.50),
                fontSize: "0.7rem",
              }}
            >
              {t("ai.hint")}
            </Typography>
          </Box>
          </Box>{/* end content zIndex wrapper */}
        </Box>

        {/* ───── PERSONAS — Who is it for? ───── */}
        <Box id="who-is-it-for" sx={{ scrollMarginTop: 16, mb: 6 }}>
          <Box sx={{ textAlign: "center", mb: 4 }}>
            <Chip
              icon={<GroupsOutlinedIcon sx={{ fontSize: "14px !important" }} />}
              label={t("useCases.chip")}
              size="small"
              sx={{
                mb: 2,
                backgroundColor: alpha(accentRaw, isDark ? 0.15 : 0.08),
                color: accent,
                fontWeight: 600,
                fontSize: "0.72rem",
                "& .MuiChip-icon": { color: `${accent} !important` },
              }}
            />
            <Typography
              variant="h4"
              fontWeight={800}
              sx={{
                color: textPrimary,
                fontSize: { xs: "1.35rem", md: "1.65rem" },
                letterSpacing: "-0.01em",
                mb: 1,
              }}
            >
              {t("useCases.whoTitle")}
            </Typography>
            <Typography
              variant="body2"
              sx={{
                color: textSecondary,
                maxWidth: 560,
                mx: "auto",
                fontSize: { xs: "0.82rem", md: "0.88rem" },
              }}
            >
              {t("useCases.whoSubtitle")}
            </Typography>
          </Box>

          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: {
                xs: "1fr",
                sm: "repeat(2, 1fr)",
                md: "repeat(3, 1fr)",
                lg: "repeat(6, 1fr)",
              },
              gap: 1.5,
            }}
          >
            {PERSONAS.map((p, i) => {
              const isActive = activePersona === i;
              const Icon = p.Icon;
              return (
                <Paper
                  key={p.tag}
                  elevation={0}
                  role="button"
                  tabIndex={0}
                  onClick={() => setActivePersona(isActive ? null : i)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setActivePersona(isActive ? null : i);
                    }
                  }}
                  sx={{
                    p: 2.25,
                    cursor: "pointer",
                    borderRadius: "14px",
                    border: `1.5px solid ${isActive ? p.color : border}`,
                    backgroundColor: isActive
                      ? alpha(p.color, isDark ? 0.1 : 0.04)
                      : surface,
                    transition: "all 0.25s cubic-bezier(0.4,0,0.2,1)",
                    "&:hover": {
                      borderColor: alpha(p.color, 0.5),
                      transform: "translateY(-2px)",
                      boxShadow: `0 8px 24px ${alpha(p.color, 0.12)}`,
                    },
                    "&:focus-visible": {
                      outline: `2px solid ${p.color}`,
                      outlineOffset: 2,
                    },
                  }}
                >
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1.25,
                      mb: 1.25,
                    }}
                  >
                    <Box
                      sx={{
                        width: 36,
                        height: 36,
                        borderRadius: "10px",
                        backgroundColor: alpha(p.color, isDark ? 0.2 : 0.1),
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <Icon sx={{ fontSize: 19, color: p.color }} />
                    </Box>
                    <Chip
                      label={p.tag}
                      size="small"
                      sx={{
                        height: 20,
                        fontSize: "0.6rem",
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                        backgroundColor: alpha(p.color, isDark ? 0.15 : 0.08),
                        color: p.color,
                      }}
                    />
                  </Box>
                  <Typography
                    variant="subtitle2"
                    fontWeight={700}
                    sx={{
                      color: textPrimary,
                      mb: 0.5,
                      fontSize: "0.8rem",
                      lineHeight: 1.3,
                    }}
                  >
                    {p.label}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{
                      color: textSecondary,
                      lineHeight: 1.55,
                      display: "block",
                      fontSize: "0.72rem",
                      maxHeight: isActive ? 240 : 0,
                      opacity: isActive ? 1 : 0,
                      overflow: "hidden",
                      transition: "all 0.3s ease",
                      mt: isActive ? 1 : 0,
                    }}
                  >
                    {p.text}
                  </Typography>
                </Paper>
              );
            })}
          </Box>
        </Box>
        {/* ───── PLANS — Read free vs Edit beta ───── */}
        <Box sx={{ pt: { xs: 4, md: 8 }, pb: { xs: 6, md: 8 } }}>
          <Box sx={{ textAlign: "center", mb: 5 }}>
            <Typography
              variant="h4"
              fontWeight={800}
              sx={{
                color: textPrimary,
                fontSize: { xs: "1.4rem", md: "1.85rem" },
                letterSpacing: "-0.01em",
                mb: 1.25,
              }}
            >
              {t("plans.title")}
            </Typography>
            <Typography
              variant="body2"
              sx={{
                color: textSecondary,
                maxWidth: 620,
                mx: "auto",
                lineHeight: 1.65,
                fontSize: { xs: "0.82rem", md: "0.9rem" },
              }}
            >
              {t("plans.subtitle")}
            </Typography>
          </Box>

          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
              gap: { xs: 2.5, md: 3 },
              maxWidth: 1100,
              mx: "auto",
            }}
          >
            {[
              {
                key: "read",
                Icon: VisibilityOutlinedIcon,
                color: "#10b981",
                heading: t("plans.read.heading"),
                tag: t("plans.read.tag"),
                subheading: t("plans.read.subheading"),
                bullets: [
                  t("plans.read.bullet0"),
                  t("plans.read.bullet1"),
                  t("plans.read.bullet2"),
                  t("plans.read.bullet3"),
                  t("plans.read.bullet4"),
                  t("plans.read.bullet5"),
                  t("plans.read.bullet6"),
                ],
                cta: t("plans.read.cta"),
                note: t("plans.read.note"),
                onClick: () => {
                  // Scroll back to dropzone smoothly
                  document
                    .querySelector("[data-dropzone-anchor]")
                    ?.scrollIntoView({ behavior: "smooth", block: "center" });
                },
                href: null,
              },
              {
                key: "edit",
                Icon: LockOutlinedIcon,
                color: "#8b5cf6",
                heading: t("plans.edit.heading"),
                tag: t("plans.edit.tag"),
                subheading: t("plans.edit.subheading"),
                bullets: [
                  t("plans.edit.bullet0"),
                  t("plans.edit.bullet1"),
                  t("plans.edit.bullet2"),
                  t("plans.edit.bullet3"),
                  t("plans.edit.bullet4"),
                  t("plans.edit.bullet5"),
                  t("plans.edit.bullet6"),
                ],
                cta: t("plans.edit.cta"),
                note: t("plans.edit.note"),
                onClick: null,
                href: `mailto:weylandbinary@gmail.com?subject=${encodeURIComponent(
                  t("mailto.subject"),
                )}&body=${encodeURIComponent(t("mailto.body"))}`,
              },
            ].map((plan, i) => (
              <Paper
                key={plan.key}
                elevation={0}
                sx={{
                  p: { xs: 3, md: 3.5 },
                  borderRadius: "20px",
                  border: `1.5px solid ${alpha(plan.color, isDark ? 0.35 : 0.25)}`,
                  backgroundColor: surface,
                  position: "relative",
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                  animation: `${fadeUp} 0.5s ease-out ${0.05 + i * 0.07}s both`,
                  transition: "all 0.25s cubic-bezier(0.4,0,0.2,1)",
                  "&:hover": {
                    transform: "translateY(-3px)",
                    borderColor: alpha(plan.color, 0.55),
                    boxShadow: `0 16px 40px ${alpha(plan.color, isDark ? 0.18 : 0.14)}`,
                  },
                }}
              >
                <Box
                  sx={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: 3,
                    background: `linear-gradient(90deg, ${alpha(plan.color, 0.5)}, ${plan.color}, ${alpha(plan.color, 0.5)})`,
                  }}
                />
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1.25,
                    mb: 2,
                  }}
                >
                  <Box
                    sx={{
                      width: 42,
                      height: 42,
                      borderRadius: "12px",
                      backgroundColor: alpha(plan.color, isDark ? 0.18 : 0.12),
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <plan.Icon sx={{ fontSize: 22, color: plan.color }} />
                  </Box>
                  <Box>
                    <Typography
                      variant="h6"
                      fontWeight={800}
                      sx={{
                        color: textPrimary,
                        fontSize: "1.1rem",
                        lineHeight: 1.1,
                        mb: 0.25,
                      }}
                    >
                      {plan.heading}
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{
                        color: plan.color,
                        fontWeight: 700,
                        fontSize: "0.66rem",
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                      }}
                    >
                      {plan.tag}
                    </Typography>
                  </Box>
                </Box>

                <Typography
                  variant="body2"
                  sx={{
                    color: textSecondary,
                    fontSize: "0.84rem",
                    lineHeight: 1.6,
                    mb: 2.5,
                  }}
                >
                  {plan.subheading}
                </Typography>

                <Box
                  component="ul"
                  sx={{
                    listStyle: "none",
                    p: 0,
                    m: 0,
                    mb: 3,
                    flex: 1,
                  }}
                >
                  {plan.bullets.map((b, j) => (
                    <Box
                      key={j}
                      component="li"
                      sx={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 1,
                        mb: 1.25,
                        fontSize: "0.83rem",
                        lineHeight: 1.55,
                        color: textPrimary,
                      }}
                    >
                      <CheckCircleOutlineIcon
                        sx={{
                          fontSize: 16,
                          color: plan.color,
                          mt: 0.3,
                          flexShrink: 0,
                        }}
                      />
                      <span>{b}</span>
                    </Box>
                  ))}
                </Box>

                <Box sx={{ mt: "auto" }}>
                  <Box
                    component={plan.href ? "a" : "button"}
                    href={plan.href || undefined}
                    onClick={plan.onClick || undefined}
                    sx={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 1,
                      width: "100%",
                      px: 3,
                      py: 1.4,
                      borderRadius: "12px",
                      border: "none",
                      background: `linear-gradient(135deg, ${plan.color}, ${alpha(plan.color, 0.78)})`,
                      color: "#fff",
                      fontSize: "0.88rem",
                      fontWeight: 700,
                      fontFamily: "inherit",
                      cursor: "pointer",
                      textDecoration: "none",
                      transition: "all 0.2s ease",
                      boxShadow: `0 4px 14px ${alpha(plan.color, 0.35)}`,
                      "&:hover": {
                        transform: "translateY(-1px)",
                        boxShadow: `0 8px 20px ${alpha(plan.color, 0.5)}`,
                      },
                    }}
                  >
                    {plan.key === "edit" && (
                      <MailOutlineIcon sx={{ fontSize: 17 }} />
                    )}
                    {plan.cta}
                  </Box>
                  <Typography
                    variant="caption"
                    sx={{
                      display: "block",
                      mt: 1.25,
                      textAlign: "center",
                      color: textSecondary,
                      fontSize: "0.7rem",
                      lineHeight: 1.4,
                    }}
                  >
                    {plan.note}
                  </Typography>
                </Box>
              </Paper>
            ))}
          </Box>
        </Box>

        {/* ───── SECURITY & SOVEREIGNTY (migrated from Use Cases) ───── */}
        <Box sx={{ pb: { xs: 6, md: 8 } }}>
          <Paper
            elevation={0}
            sx={{
              p: { xs: 3, md: 4 },
              borderRadius: "20px",
              border: `1px solid ${border}`,
              backgroundColor: isDark
                ? alpha("#fff", 0.02)
                : alpha("#0f172a", 0.02),
              maxWidth: 1100,
              mx: "auto",
            }}
          >
            <Box sx={{ textAlign: "center", mb: 3 }}>
              <Box
                sx={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 1,
                  mb: 1.5,
                }}
              >
                <VerifiedIcon sx={{ color: accent, fontSize: 22 }} />
                <Typography
                  variant="h4"
                  fontWeight={800}
                  sx={{
                    color: textPrimary,
                    fontSize: { xs: "1.2rem", md: "1.5rem" },
                    letterSpacing: "-0.01em",
                  }}
                >
                  {t("useCases.trustTitle")}
                </Typography>
              </Box>
              <Typography
                variant="body2"
                sx={{
                  color: textSecondary,
                  fontSize: { xs: "0.82rem", md: "0.88rem" },
                  maxWidth: 640,
                  mx: "auto",
                  lineHeight: 1.6,
                }}
              >
                {t("useCases.trustSubtitle")}
              </Typography>
            </Box>

            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: {
                  xs: "1fr 1fr",
                  md: "repeat(4, 1fr)",
                },
                gap: 1.5,
              }}
            >
              {SECURITY_PROOFS.map((s) => {
                const Icon = s.Icon;
                return (
                  <Box
                    key={s.label}
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1.25,
                      p: 1.75,
                      borderRadius: "12px",
                      backgroundColor: isDark
                        ? alpha("#fff", 0.03)
                        : alpha("#000", 0.02),
                      border: `1px solid ${border}`,
                    }}
                  >
                    <Icon sx={{ fontSize: 22, color: accent, flexShrink: 0 }} />
                    <Box sx={{ minWidth: 0 }}>
                      <Typography
                        variant="caption"
                        fontWeight={700}
                        sx={{
                          color: textPrimary,
                          display: "block",
                          fontSize: "0.78rem",
                          lineHeight: 1.3,
                        }}
                      >
                        {s.label}
                      </Typography>
                      <Typography
                        variant="caption"
                        sx={{
                          color: textSecondary,
                          fontSize: "0.68rem",
                          lineHeight: 1.3,
                        }}
                      >
                        {s.sub}
                      </Typography>
                    </Box>
                  </Box>
                );
              })}
            </Box>
          </Paper>
        </Box>

        {/* ───── FAQ ───── */}
        <Box sx={{ pb: { xs: 6, md: 8 } }}>
          <Box sx={{ textAlign: "center", mb: 4 }}>
            <Chip
              icon={<HelpOutlineIcon sx={{ fontSize: "14px !important" }} />}
              label={t("faq.chip")}
              size="small"
              sx={{
                mb: 2,
                backgroundColor: alpha(accentRaw, isDark ? 0.15 : 0.08),
                color: accent,
                fontWeight: 600,
                fontSize: "0.72rem",
                "& .MuiChip-icon": { color: `${accent} !important` },
              }}
            />
            <Typography
              variant="h4"
              fontWeight={800}
              sx={{
                color: textPrimary,
                fontSize: { xs: "1.35rem", md: "1.65rem" },
                letterSpacing: "-0.01em",
                mb: 1,
              }}
            >
              {t("faq.title")}
            </Typography>
            <Typography
              variant="body2"
              sx={{
                color: textSecondary,
                maxWidth: 560,
                mx: "auto",
                fontSize: { xs: "0.82rem", md: "0.88rem" },
              }}
            >
              {t("faq.subtitle")}
            </Typography>
          </Box>

          <Box sx={{ maxWidth: 820, mx: "auto" }}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Accordion
                key={i}
                disableGutters
                elevation={0}
                square
                sx={{
                  backgroundColor: "transparent",
                  border: `1px solid ${border}`,
                  borderRadius: "14px !important",
                  mb: 1.25,
                  overflow: "hidden",
                  "&:before": { display: "none" },
                  "&.Mui-expanded": {
                    backgroundColor: isDark
                      ? alpha(accentRaw, 0.04)
                      : alpha(accentRaw, 0.02),
                    borderColor: alpha(accentRaw, 0.3),
                  },
                }}
              >
                <AccordionSummary
                  expandIcon={<ExpandMoreIcon sx={{ color: textSecondary }} />}
                  sx={{
                    px: { xs: 2, md: 2.5 },
                    "& .MuiAccordionSummary-content": { my: 1.4 },
                  }}
                >
                  <Typography
                    fontWeight={700}
                    sx={{
                      color: textPrimary,
                      fontSize: { xs: "0.88rem", md: "0.95rem" },
                    }}
                  >
                    {t(`faq.q${i}`)}
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ px: { xs: 2, md: 2.5 }, pt: 0 }}>
                  <Typography
                    sx={{
                      color: textSecondary,
                      fontSize: "0.85rem",
                      lineHeight: 1.7,
                    }}
                  >
                    {t(`faq.a${i}`)}
                  </Typography>
                </AccordionDetails>
              </Accordion>
            ))}
          </Box>
        </Box>

        {/* ───── TRUST STRIP ───── */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: { xs: 2, md: 4 },
            pb: 10,
            flexWrap: "wrap",
            animation: `${fadeUp} 0.5s ease-out 0.3s both`,
          }}
        >
          {TRUST_ITEMS.map((t) => {
            const Icon = t.icon;
            return (
              <Box
                key={t.label}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.75,
                  opacity: 0.55,
                }}
              >
                <Icon sx={{ fontSize: 16, color: textSecondary }} />
                <Typography
                  variant="caption"
                  sx={{
                    color: textSecondary,
                    fontSize: "0.68rem",
                    fontWeight: 600,
                  }}
                >
                  {t.label}
                </Typography>
              </Box>
            );
          })}

          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.75,
              opacity: 0.55,
            }}
          >
            <Typography
              variant="caption"
              sx={{ color: textSecondary, fontSize: "0.68rem" }}
            >
              ·
            </Typography>
          </Box>

          <Typography
            component="a"
            href="#who-is-it-for"
            variant="caption"
            onClick={(e) => {
              e.preventDefault();
              document
                .getElementById("who-is-it-for")
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            sx={{
              color: accent,
              fontWeight: 600,
              fontSize: "0.7rem",
              cursor: "pointer",
              textDecoration: "none",
              "&:hover": { textDecoration: "underline" },
            }}
          >
            {t("trust.useCases")}
          </Typography>
        </Box>

        <BetaGateDialog
          open={betaGateOpen}
          onClose={() => {
            setBetaGateOpen(false);
            setPendingProjectFile(null);
            setBetaGateInitialError(null);
          }}
          onSubmit={handleBetaSubmitForOpenProject}
          initialError={betaGateInitialError}
        />

        {/* ───── Lightbox: zoom-in any showcase screenshot ───── */}
        <Dialog
          open={Boolean(lightboxItem)}
          onClose={() => setLightboxItem(null)}
          maxWidth={false}
          fullWidth
          TransitionComponent={Fade}
          transitionDuration={200}
          PaperProps={{
            sx: {
              backgroundColor: "transparent",
              boxShadow: "none",
              m: { xs: 1.5, md: 3 },
              maxHeight: "calc(100vh - 32px)",
              overflow: "visible",
            },
          }}
          BackdropProps={{
            sx: {
              backgroundColor: "rgba(7, 14, 26, 0.86)",
              backdropFilter: "blur(6px)",
            },
          }}
        >
          {lightboxItem && (
            <Box
              sx={{
                position: "relative",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 1.5,
                outline: "none",
              }}
            >
              <Box
                component="img"
                src={lightboxItem.src}
                alt={lightboxItem.alt}
                onClick={() => setLightboxItem(null)}
                sx={{
                  display: "block",
                  maxWidth: "100%",
                  maxHeight: "calc(100vh - 120px)",
                  width: "auto",
                  height: "auto",
                  borderRadius: "14px",
                  boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
                  border: `1px solid ${alpha(lightboxItem.color, 0.4)}`,
                  cursor: "zoom-out",
                }}
              />
              <Typography
                variant="caption"
                sx={{
                  color: "rgba(255,255,255,0.65)",
                  fontSize: "0.75rem",
                  letterSpacing: "0.04em",
                }}
              >
                {lightboxItem.eyebrow} · {lightboxItem.title}
              </Typography>
              <IconButton
                onClick={() => setLightboxItem(null)}
                aria-label="Close"
                sx={{
                  position: "absolute",
                  top: -8,
                  right: -8,
                  backgroundColor: "rgba(15,23,42,0.85)",
                  color: "#fff",
                  width: 36,
                  height: 36,
                  border: "1px solid rgba(255,255,255,0.18)",
                  "&:hover": {
                    backgroundColor: "rgba(15,23,42,1)",
                    borderColor: "rgba(255,255,255,0.35)",
                  },
                }}
              >
                <CloseIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Box>
          )}
        </Dialog>
      </Container>
    </Box>
  );
}

export default GTFSUploader;
