import React, { useRef, useEffect } from "react";
import { Box, Typography, Chip } from "@mui/material";
import { useTheme, alpha } from "@mui/material/styles";
import { SHAPE_PALETTE } from "../LineMap";
import { formatShapeLabel } from "../../utils/shapeLabel";
import { useLanguage } from "../../contexts/LanguageContext";

function km(m) {
  return m ? `${(m / 1000).toFixed(1)} km` : "0 km";
}

// The list of a line's shapes, rendered as colour-chipped cards with derived
// human labels. Clicking a card selects the shape; hovering syncs with the
// map polyline (and vice-versa). A map-originated hover scrolls the card in.
export default function StudioShapeList({
  shapes = [],
  labels,
  selectedShapeId,
  onSelect,
  hoveredShapeId,
  onHoverShape,
  hoverSource,
}) {
  const { t } = useLanguage();
  const theme = useTheme();
  const containerRef = useRef(null);

  // When the hover originates from the map, scroll the matching card into view.
  useEffect(() => {
    if (hoverSource !== "map" || !hoveredShapeId || !containerRef.current) return;
    const el = containerRef.current.querySelector(
      `[data-shape-id="${CSS.escape(hoveredShapeId)}"]`,
    );
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [hoveredShapeId, hoverSource]);

  return (
    <Box
      ref={containerRef}
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 0.75,
        p: 1,
        overflowY: "auto",
        minHeight: 0,
      }}
    >
      {shapes.map((s, idx) => {
        const color = SHAPE_PALETTE[idx % SHAPE_PALETTE.length];
        const desc = labels?.get(s.shape_id);
        const { primary, secondary } = formatShapeLabel(s.shape_id, desc, t);
        const sel = selectedShapeId === s.shape_id;
        const hov = !sel && hoveredShapeId === s.shape_id;
        return (
          <Box
            key={s.shape_id}
            data-shape-id={s.shape_id}
            onClick={() => onSelect(s.shape_id)}
            onMouseEnter={() => onHoverShape && onHoverShape(s.shape_id)}
            onMouseLeave={() => onHoverShape && onHoverShape(null)}
            sx={{
              cursor: "pointer",
              borderRadius: 1.5,
              p: 1,
              pl: 1.25,
              borderLeft: `4px solid ${color}`,
              backgroundColor: sel
                ? alpha(theme.palette.primary.main, 0.14)
                : hov
                  ? alpha(theme.palette.primary.main, 0.07)
                  : theme.palette.action.hover,
              outline: sel
                ? `1px solid ${theme.palette.primary.main}`
                : hov
                  ? `1px solid ${alpha(theme.palette.primary.main, 0.4)}`
                  : "1px solid transparent",
              transition: "background-color 0.15s ease, outline-color 0.15s ease",
              "&:hover": {
                backgroundColor: alpha(theme.palette.primary.main, 0.08),
              },
            }}
          >
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 1,
              }}
            >
              <Typography variant="body2" fontWeight={600} noWrap>
                {primary}
              </Typography>
              {desc?.isShared && (
                <Chip
                  size="small"
                  variant="outlined"
                  color="warning"
                  label={t("shapeStudio.label.shared")}
                  sx={{ height: 18, fontSize: 10 }}
                />
              )}
            </Box>
            <Typography
              variant="caption"
              color="text.secondary"
              noWrap
              sx={{ fontFamily: "monospace", display: "block", opacity: 0.8 }}
            >
              {secondary}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t("shapeStudio.status.points", {
                count: desc?.pointCount ?? s.point_count,
              })}
              {" · "}
              {km(desc?.distanceM)}
              {" · "}
              {t("shapeStudio.status.trips", { count: s.trip_count })}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}
