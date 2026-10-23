/**
 * How to modify a network, by hand or with a brief, asked in a dialog over the page: from Home's « Modifier » before
 * any project is made, and on a draft that has no way yet, over its network. `onStart(kind)` takes the choice; keys
 * 1 and 2 choose too. Closing chooses nothing.
 */

import React, { useEffect } from "react";
import { Box, ButtonBase, Dialog, IconButton, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { kindToneOf } from "./draftKinds";

const WAYS = [
  { kind: "hand", icon: EditOutlinedIcon, key: "1" },
  { kind: "brief", icon: DescriptionOutlinedIcon, key: "2" },
];

const MOTION = {
  "@keyframes wayIn": { "0%": { transform: "translateY(10px)", opacity: 0 }, "100%": { transform: "none", opacity: 1 } },
  "@media (prefers-reduced-motion: reduce)": { "&, & *": { animation: "none !important", transition: "none !important" } },
};

function WayCard({ kind, icon: Icon, shortcut, index, onStart }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const tone = kindToneOf(theme, kind);
  return (
    <ButtonBase
      onClick={() => onStart(kind)}
      data-testid={`draft-choose-${kind}`}
      sx={{
        flex: "1 1 260px",
        minWidth: 0,
        p: 2.5,
        borderRadius: "16px",
        border: `1.5px solid ${theme.palette.divider}`,
        backgroundColor: theme.palette.background.paper,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 1.25,
        textAlign: "left",
        position: "relative",
        animation: "wayIn 380ms cubic-bezier(.2,.8,.2,1) both",
        animationDelay: `${80 + index * 70}ms`,
        transition: "border-color .15s, box-shadow .15s, transform .15s, background-color .15s",
        "& .way-go": { opacity: 0, transform: "translateX(-4px)", transition: "opacity .15s, transform .15s" },
        "&:hover, &.Mui-focusVisible": {
          borderColor: tone,
          backgroundColor: alpha(tone, theme.palette.mode === "dark" ? 0.08 : 0.035),
          boxShadow: `0 12px 32px ${alpha(tone, 0.18)}`,
          transform: "translateY(-2px)",
          "& .way-go": { opacity: 1, transform: "none" },
        },
        "&.Mui-focusVisible": { outline: `2px solid ${tone}`, outlineOffset: 2 },
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
        <Box aria-hidden sx={{ width: 46, height: 46, borderRadius: "13px", display: "grid", placeItems: "center", color: tone, backgroundColor: alpha(tone, 0.13) }}>
          <Icon />
        </Box>
        <Box component="kbd" aria-hidden sx={{ px: 0.8, py: 0.1, borderRadius: "6px", border: `1px solid ${theme.palette.divider}`, fontFamily: "inherit", fontSize: "0.72rem", fontWeight: 700, color: "text.secondary" }}>
          {shortcut}
        </Box>
      </Box>
      <Typography sx={{ fontSize: "1.02rem", fontWeight: 750 }}>{t(`draft.kind.${kind}`)}</Typography>
      <Typography sx={{ fontSize: "0.84rem", color: "text.secondary", lineHeight: 1.5 }}>{t(`draft.kind.${kind}.hint`)}</Typography>
      <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.5, mt: 0.25 }}>
        {[1, 2].map((i) => (
          <Box key={i} component="li" sx={{ display: "flex", alignItems: "center", gap: 0.75, fontSize: "0.8rem", color: "text.primary" }}>
            <CheckRoundedIcon aria-hidden sx={{ fontSize: 16, color: tone }} />
            {t(`draft.kind.${kind}.point${i}`)}
          </Box>
        ))}
      </Box>
      <Box className="way-go" aria-hidden sx={{ mt: "auto", pt: 0.5, display: "flex", alignItems: "center", gap: 0.5, fontSize: "0.84rem", fontWeight: 700, color: tone }}>
        {t("draft.choose.go")}
        <ArrowForwardRoundedIcon sx={{ fontSize: 17 }} />
      </Box>
    </ButtonBase>
  );
}

export default function WayChoice({ open = true, onStart, onClose = null, networkName = null }) {
  const theme = useTheme();
  const { t } = useLanguage();
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const tag = String(e.target?.tagName || "").toLowerCase();
      if (["input", "textarea", "select"].includes(tag)) return;
      const way = WAYS.find((w) => w.key === e.key);
      if (!way) return;
      e.preventDefault();
      onStart(way.kind);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onStart]);
  return (
    <Dialog open={open} onClose={onClose || undefined} fullWidth maxWidth="md" aria-labelledby="draft-choose-title" PaperProps={{ "data-testid": "draft-choose", sx: { ...MOTION, borderRadius: "22px", overflow: "hidden" } }}>
      <Box sx={{ px: { xs: 2.5, sm: 3.5 }, pt: 3, pb: 3.5, display: "flex", flexDirection: "column", gap: 2.5, background: `radial-gradient(120% 60% at 50% 0%, ${alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.12 : 0.06)}, transparent 70%)` }}>
        <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {networkName && (
              <Typography data-testid="draft-choose-network" sx={{ fontSize: "0.78rem", fontWeight: 700, color: "primary.main", letterSpacing: "0.02em", mb: 0.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {networkName}
              </Typography>
            )}
            <Typography id="draft-choose-title" component="h2" sx={{ fontSize: { xs: "1.25rem", sm: "1.45rem" }, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.2 }}>
              {t("draft.choose.title")}
            </Typography>
            <Typography sx={{ mt: 0.5, fontSize: "0.88rem", color: "text.secondary" }}>{t("draft.choose.sub")}</Typography>
          </Box>
          {onClose && (
            <Tooltip title={t("app.close")}>
              <IconButton onClick={onClose} aria-label={t("app.close")} data-testid="draft-choose-close" sx={{ mt: -0.5, mr: -1, color: "text.secondary", transition: "transform .18s", "&:hover": { transform: "rotate(90deg)" } }}>
                <CloseRoundedIcon />
              </IconButton>
            </Tooltip>
          )}
        </Box>
        <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap", alignItems: "stretch" }}>
          {WAYS.map((w, i) => (
            <WayCard key={w.kind} kind={w.kind} icon={w.icon} shortcut={w.key} index={i} onStart={onStart} />
          ))}
        </Box>
      </Box>
    </Dialog>
  );
}
