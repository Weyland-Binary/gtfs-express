import React, { useMemo, useState, useRef } from "react";
import {
  Box,
  TextField,
  InputAdornment,
  IconButton,
  Tooltip,
  Popover,
  Typography,
  Button,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import ColorizeIcon from "@mui/icons-material/Colorize";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CheckIcon from "@mui/icons-material/Check";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import PaletteIcon from "@mui/icons-material/Palette";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { useLanguage } from "../../contexts/LanguageContext";

const HEX_RE = /^[0-9A-Fa-f]{6}$/;

// ── Color math ───────────────────────────────────────────────────────
const hexToRgb = (hex) => {
  if (!HEX_RE.test(hex)) return null;
  return {
    r: parseInt(hex.substring(0, 2), 16),
    g: parseInt(hex.substring(2, 4), 16),
    b: parseInt(hex.substring(4, 6), 16),
  };
};

const relLum = ({ r, g, b }) => {
  const norm = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * norm(r) + 0.7152 * norm(g) + 0.0722 * norm(b);
};

const contrastRatio = (hexA, hexB) => {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return null;
  const la = relLum(a);
  const lb = relLum(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
};

// Pick FFFFFF or 000000 to maximise contrast vs a background
export const bestContrastColor = (bgHex) => {
  if (!HEX_RE.test(bgHex)) return "FFFFFF";
  const rgb = hexToRgb(bgHex);
  return relLum(rgb) > 0.5 ? "000000" : "FFFFFF";
};

const stripHash = (v) => (v || "").replace(/^#/, "").trim();

// ── GTFS-style route color presets, grouped by family ──────────────
const PRESET_GROUPS = [
  {
    labelKey: "colorPicker.groupTransit",
    colors: [
      "D62728", "FF7F0E", "FFD700", "2CA02C",
      "1F77B4", "9467BD", "E377C2", "8C564B",
    ],
  },
  {
    labelKey: "colorPicker.groupVivid",
    colors: [
      "E41A1C", "FF7F00", "FFFF33", "4DAF4A",
      "377EB8", "984EA3", "F781BF", "A65628",
    ],
  },
  {
    labelKey: "colorPicker.groupNeutral",
    colors: [
      "000000", "424242", "757575", "BDBDBD",
      "E0E0E0", "F5F5F5", "FFFFFF", "17BECF",
    ],
  },
];

function ContrastBadge({ ratio, t }) {
  if (ratio == null) return null;
  // WCAG AA: 4.5 for normal text, 3.0 for large text
  const passesAA = ratio >= 4.5;
  const passesAALarge = ratio >= 3;
  const label = passesAA
    ? t("colorPicker.wcagAA")
    : passesAALarge
      ? t("colorPicker.wcagAALarge")
      : t("colorPicker.wcagFail");
  const color = passesAA
    ? "success.main"
    : passesAALarge
      ? "warning.main"
      : "error.main";
  const Icon = passesAA ? CheckCircleIcon : WarningAmberIcon;
  return (
    <Tooltip
      title={t("colorPicker.contrastTooltip", { ratio: ratio.toFixed(2) })}
      arrow
    >
      <Box
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: 0.25,
          color,
          fontSize: 10,
          fontWeight: 700,
          ml: 0.5,
        }}
      >
        <Icon sx={{ fontSize: 13 }} />
        {label} · {ratio.toFixed(1)}
      </Box>
    </Tooltip>
  );
}

/**
 * Visual color picker with WCAG contrast feedback.
 *
 *   value     — 6-char hex (no #) or empty
 *   onChange  — (newHex without #)
 *   contrastAgainst — optional companion hex (e.g. route_text_color for
 *     route_color field). When present, a WCAG AA/AALarge/Fail badge is
 *     shown inline.
 *   onAutoPickContrast — when clicked, sets the value via callback to
 *     the best B/W choice vs contrastAgainst.
 */
function ColorPickerField({
  label,
  value,
  onChange,
  contrastAgainst,
  disabled,
  size = "small",
  autoFocus,
  sx,
}) {
  const { t } = useLanguage();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const [anchor, setAnchor] = useState(null);
  const nativeRef = useRef(null);

  const clean = useMemo(() => stripHash(value).toUpperCase(), [value]);
  const isValid = HEX_RE.test(clean);
  const cssHex = isValid ? `#${clean}` : "transparent";

  const ratio = useMemo(() => {
    if (!isValid || !contrastAgainst || !HEX_RE.test(stripHash(contrastAgainst)))
      return null;
    return contrastRatio(clean, stripHash(contrastAgainst));
  }, [clean, contrastAgainst, isValid]);

  const cleanContrast = useMemo(
    () => stripHash(contrastAgainst).toUpperCase(),
    [contrastAgainst],
  );
  const hasContrastTarget = HEX_RE.test(cleanContrast);
  const suggestedAuto = hasContrastTarget
    ? bestContrastColor(cleanContrast)
    : null;
  const showAutoSuggestion =
    suggestedAuto != null && suggestedAuto !== clean;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", ...sx }}>
      <TextField
        label={label}
        value={clean}
        onChange={(e) => onChange?.(stripHash(e.target.value).toUpperCase())}
        disabled={disabled}
        size={size}
        placeholder="RRGGBB"
        autoFocus={autoFocus}
        inputProps={{
          maxLength: 6,
          style: { fontFamily: "monospace", textTransform: "uppercase" },
        }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <Tooltip title={t("colorPicker.presets")} arrow>
                <IconButton
                  size="small"
                  disabled={disabled}
                  onClick={(e) => setAnchor(e.currentTarget)}
                  sx={{
                    p: 0.25,
                    width: 28,
                    height: 28,
                    borderRadius: 1,
                    border: "1px solid",
                    borderColor: isValid
                      ? "transparent"
                      : (isDark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.18)"),
                    background: isValid
                      ? cssHex
                      : `repeating-conic-gradient(${
                          isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)"
                        } 0% 25%, transparent 0% 50%) 50% / 8px 8px`,
                    boxShadow: isValid
                      ? "inset 0 0 0 1px rgba(0,0,0,0.10)"
                      : "none",
                    transition: "filter 0.12s ease, box-shadow 0.12s ease",
                    "&:hover": {
                      background: isValid
                        ? cssHex
                        : `repeating-conic-gradient(${
                            isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.06)"
                          } 0% 25%, transparent 0% 50%) 50% / 8px 8px`,
                      filter: isValid ? "brightness(0.94)" : "none",
                      boxShadow: isValid
                        ? "inset 0 0 0 1px rgba(0,0,0,0.18)"
                        : "none",
                    },
                  }}
                >
                  <Box sx={{ width: 18, height: 18 }} />
                </IconButton>
              </Tooltip>
              <input
                ref={nativeRef}
                type="color"
                value={isValid ? `#${clean}` : "#000000"}
                onChange={(e) =>
                  onChange?.(stripHash(e.target.value).toUpperCase())
                }
                style={{ display: "none" }}
              />
            </InputAdornment>
          ),
          endAdornment: (
            <InputAdornment position="end">
              <Tooltip title={t("colorPicker.pickFromWheel")} arrow>
                <IconButton
                  size="small"
                  disabled={disabled}
                  onClick={() => nativeRef.current?.click()}
                  sx={{ color: "text.secondary" }}
                >
                  <ColorizeIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            </InputAdornment>
          ),
        }}
      />
      {ratio != null && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            minHeight: 18,
            mt: 0.25,
          }}
        >
          <ContrastBadge ratio={ratio} t={t} />
        </Box>
      )}
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{
          paper: {
            sx: {
              mt: 0.5,
              borderRadius: 2,
              overflow: "hidden",
              border: `1px solid ${isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)"}`,
              boxShadow: isDark
                ? "0 12px 36px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.4)"
                : "0 12px 36px rgba(15,23,42,0.14), 0 2px 6px rgba(15,23,42,0.06)",
              backgroundImage: "none",
              backgroundColor: isDark ? "#1a1f2e" : "#ffffff",
            },
          },
        }}
      >
        <Box sx={{ width: 296 }}>
          {/* Header — current swatch + hex */}
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.25,
              px: 1.75,
              py: 1.25,
              borderBottom: `1px solid ${isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)"}`,
            }}
          >
            <Box
              sx={{
                width: 36,
                height: 36,
                borderRadius: 1.25,
                background: isValid
                  ? cssHex
                  : `repeating-conic-gradient(${
                      isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)"
                    } 0% 25%, transparent 0% 50%) 50% / 10px 10px`,
                border: `1px solid ${isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.10)"}`,
                boxShadow: isValid ? "inset 0 0 0 1px rgba(0,0,0,0.08)" : "none",
                flexShrink: 0,
              }}
            />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.5,
                  fontSize: "0.68rem",
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "text.secondary",
                  mb: 0.25,
                }}
              >
                <PaletteIcon sx={{ fontSize: 12 }} />
                {label || t("colorPicker.presets")}
              </Box>
              <Typography
                sx={{
                  fontFamily: "'Roboto Mono', monospace",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  color: isValid ? "text.primary" : "text.disabled",
                  letterSpacing: "0.04em",
                }}
              >
                {isValid ? `#${clean}` : "—"}
              </Typography>
            </Box>
            {ratio != null && <ContrastBadge ratio={ratio} t={t} />}
          </Box>

          {/* Auto-pick contrast suggestion */}
          {showAutoSuggestion && (
            <Box
              sx={{
                px: 1.75,
                py: 0.75,
                borderBottom: `1px solid ${isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)"}`,
                backgroundColor: isDark
                  ? "rgba(99,102,241,0.08)"
                  : "rgba(99,102,241,0.05)",
              }}
            >
              <Button
                size="small"
                fullWidth
                startIcon={<AutoAwesomeIcon sx={{ fontSize: 14 }} />}
                onClick={() => {
                  onChange?.(suggestedAuto);
                  setAnchor(null);
                }}
                sx={{
                  textTransform: "none",
                  fontWeight: 600,
                  fontSize: "0.72rem",
                  color: theme.palette.primary.main,
                  justifyContent: "flex-start",
                  py: 0.25,
                  "&:hover": {
                    backgroundColor: isDark
                      ? "rgba(99,102,241,0.14)"
                      : "rgba(99,102,241,0.08)",
                  },
                }}
              >
                {t("colorPicker.autoContrast", { hex: `#${suggestedAuto}` }) ||
                  `Auto-contrast: #${suggestedAuto}`}
              </Button>
            </Box>
          )}

          {/* Preset groups */}
          <Box sx={{ p: 1.5, display: "flex", flexDirection: "column", gap: 1.25 }}>
            {PRESET_GROUPS.map((group) => (
              <Box key={group.labelKey}>
                <Typography
                  sx={{
                    fontSize: "0.62rem",
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "text.secondary",
                    opacity: 0.7,
                    mb: 0.75,
                  }}
                >
                  {t(group.labelKey)}
                </Typography>
                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: "repeat(8, 1fr)",
                    gap: 0.75,
                  }}
                >
                  {group.colors.map((hex) => {
                    const selected = clean === hex;
                    const isLight =
                      hex === "FFFFFF" ||
                      hex === "F5F5F5" ||
                      hex === "FFFF33" ||
                      hex === "E0E0E0";
                    return (
                      <Tooltip key={hex} title={`#${hex}`} arrow>
                        <Box
                          onClick={() => {
                            onChange?.(hex);
                            setAnchor(null);
                          }}
                          sx={{
                            width: 28,
                            height: 28,
                            borderRadius: 1,
                            background: `#${hex}`,
                            cursor: "pointer",
                            position: "relative",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            border: `1px solid ${
                              selected
                                ? theme.palette.primary.main
                                : isLight
                                  ? (isDark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.14)")
                                  : "transparent"
                            }`,
                            boxShadow: selected
                              ? `0 0 0 2px ${theme.palette.background.paper}, 0 0 0 4px ${theme.palette.primary.main}`
                              : "inset 0 0 0 1px rgba(0,0,0,0.06)",
                            transform: selected ? "scale(1.05)" : "scale(1)",
                            transition: "transform 0.12s ease, box-shadow 0.12s ease",
                            "&:hover": {
                              transform: "scale(1.12)",
                              boxShadow: selected
                                ? `0 0 0 2px ${theme.palette.background.paper}, 0 0 0 4px ${theme.palette.primary.main}`
                                : "inset 0 0 0 1px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.18)",
                            },
                          }}
                        >
                          {selected && (
                            <CheckIcon
                              sx={{
                                fontSize: 16,
                                color: bestContrastColor(hex) === "FFFFFF"
                                  ? "#ffffff"
                                  : "#000000",
                                filter: "drop-shadow(0 1px 1px rgba(0,0,0,0.35))",
                              }}
                            />
                          )}
                        </Box>
                      </Tooltip>
                    );
                  })}
                </Box>
              </Box>
            ))}
          </Box>

          {/* Footer — native picker */}
          <Box
            sx={{
              px: 1.5,
              py: 1,
              borderTop: `1px solid ${isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)"}`,
              backgroundColor: isDark
                ? "rgba(255,255,255,0.015)"
                : "rgba(0,0,0,0.015)",
            }}
          >
            <Button
              size="small"
              fullWidth
              startIcon={<ColorizeIcon sx={{ fontSize: 14 }} />}
              onClick={() => nativeRef.current?.click()}
              sx={{
                textTransform: "none",
                fontWeight: 500,
                fontSize: "0.75rem",
                color: "text.secondary",
                justifyContent: "flex-start",
                py: 0.25,
                "&:hover": {
                  backgroundColor: isDark
                    ? "rgba(255,255,255,0.04)"
                    : "rgba(0,0,0,0.03)",
                  color: "text.primary",
                },
              }}
            >
              {t("colorPicker.pickFromWheel")}
            </Button>
          </Box>
        </Box>
      </Popover>
    </Box>
  );
}

export default ColorPickerField;
