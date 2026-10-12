import React from "react";
import {
  Box,
  Typography,
  Button,
  IconButton,
  Tooltip,
  Chip,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import EditIcon from "@mui/icons-material/Edit";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import LinkIcon from "@mui/icons-material/Link";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import WrongLocationIcon from "@mui/icons-material/WrongLocation";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import { useLanguage } from "../../contexts/LanguageContext";

function formatKm(distanceM) {
  if (!distanceM) return "0 km";
  return `${(distanceM / 1000).toFixed(1)} km`;
}

// Glass status strip floating over the bottom of the map. Shows the selected
// shape's summary plus its object-first contextual actions, or a prompt.
export default function StudioStatusStrip({
  selectedShape, // { shape_id, label, pointCount, distanceM, tripCount, isShared, fit, unused }
  editingActive,
  onEdit,
  onDuplicate,
  onLink,
  onDelete,
  onFlyOffTrace,
}) {
  const { t } = useLanguage();
  const fit = selectedShape?.fit || null;
  const offCount = fit ? fit.offTrace.length : 0;

  return (
    <Box
      data-testid="studio-status-strip"
      sx={(theme) => ({
        position: "absolute",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 900,
        maxWidth: "calc(100% - 32px)",
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        px: 2,
        py: 1,
        borderRadius: 3,
        backgroundColor: alpha(theme.palette.background.paper, 0.92),
        backdropFilter: "blur(8px)",
        border: `1px solid ${theme.palette.divider}`,
        boxShadow: theme.shadows[6],
      })}
    >
      {selectedShape ? (
        <>
          <Box sx={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <Typography variant="body2" fontWeight={600} noWrap>
              {selectedShape.label}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap>
              {t("shapeStudio.status.points", {
                count: selectedShape.pointCount,
              })}
              {" · "}
              {formatKm(selectedShape.distanceM)}
              {" · "}
              {t("shapeStudio.status.trips", {
                count: selectedShape.tripCount,
              })}
            </Typography>
          </Box>
          {(selectedShape.isShared || editingActive) &&
            selectedShape.tripCount > 0 && (
              <Chip
                size="small"
                color="warning"
                variant="outlined"
                icon={<WarningAmberIcon sx={{ fontSize: 16 }} />}
                label={t("shapeStudio.warn.tripsAffected", {
                  count: selectedShape.tripCount,
                })}
              />
            )}
          {selectedShape.unused && (
            <Chip
              size="small"
              color="default"
              variant="outlined"
              label={t("shapeStudio.card.unused")}
            />
          )}
          {fit && offCount > 0 && (
            <Tooltip title={t("edit.shape.fit.offTraceTooltip", { m: 100 })} arrow>
              <Chip
                size="small"
                color="error"
                icon={<WrongLocationIcon sx={{ fontSize: 16 }} />}
                label={t("shapeStudio.card.offTrace", { count: offCount })}
                onClick={onFlyOffTrace}
                data-testid="studio-strip-offtrace"
              />
            </Tooltip>
          )}
          {fit && offCount === 0 && fit.results.length > 0 && !editingActive && (
            <Tooltip title={t("edit.shape.fit.okTooltip", { m: 100 })} arrow>
              <Chip
                size="small"
                color="success"
                variant="outlined"
                icon={<CheckCircleOutlineIcon sx={{ fontSize: 16 }} />}
                label={t("edit.shape.fit.ok", { count: fit.results.length })}
              />
            </Tooltip>
          )}
          <Box sx={{ display: "flex", gap: 0.5, ml: 1 }}>
            <Button
              size="small"
              variant="contained"
              startIcon={<EditIcon />}
              onClick={onEdit}
              disabled={editingActive}
              data-testid="studio-edit"
            >
              {t("shapeStudio.action.edit")}
            </Button>
            <Tooltip title={t("shapeStudio.action.link")}>
              <span>
                <IconButton
                  size="small"
                  color="primary"
                  onClick={onLink}
                  disabled={editingActive}
                  aria-label={t("shapeStudio.action.link")}
                  data-testid="studio-link"
                >
                  <LinkIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={t("shapeStudio.action.duplicate")}>
              <span>
                <IconButton
                  size="small"
                  onClick={onDuplicate}
                  disabled={editingActive}
                  aria-label={t("shapeStudio.action.duplicate")}
                  data-testid="studio-duplicate"
                >
                  <ContentCopyIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={t("shapeStudio.action.delete")}>
              <span>
                <IconButton
                  size="small"
                  color="error"
                  onClick={onDelete}
                  disabled={editingActive}
                  aria-label={t("shapeStudio.action.delete")}
                  data-testid="studio-delete"
                >
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        </>
      ) : (
        <Typography variant="body2" color="text.secondary">
          {t("shapeStudio.status.selectPrompt")}
        </Typography>
      )}
    </Box>
  );
}
