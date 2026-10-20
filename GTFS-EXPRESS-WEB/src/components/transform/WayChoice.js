/**
 * WayChoice — the draft's first screen: the two kinds of a modification, by hand (the reader full page, each retouche
 * written in the draft's own copy) or with a brief (the direct mode's one screen, DirectChange). `onStart(kind)` is the
 * studio's (ChangeStudio): it records the kind on the project (context.draft_kind).
 */

import React from "react";
import { Box, ButtonBase, Typography, alpha, useTheme } from "@mui/material";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { kindToneOf } from "./draftKinds";

export default function WayChoice({ onStart }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const card = (kind, Icon) => (
    <ButtonBase key={kind} onClick={() => onStart(kind)} data-testid={`draft-choose-${kind}`} sx={{ flex: "1 1 280px", maxWidth: 360, p: 2.5, borderRadius: "16px", border: `1px solid ${alpha(kindToneOf(theme, kind), 0.35)}`, borderTop: `4px solid ${kindToneOf(theme, kind)}`, backgroundColor: theme.palette.background.paper, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1, textAlign: "left", transition: "border-color .15s, box-shadow .15s, background-color .15s", "&:hover": { borderColor: kindToneOf(theme, kind), backgroundColor: alpha(kindToneOf(theme, kind), 0.04), boxShadow: `0 8px 24px ${alpha(theme.palette.common.black, 0.08)}` } }}>
      <Box aria-hidden sx={{ width: 44, height: 44, borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", color: kindToneOf(theme, kind), backgroundColor: alpha(kindToneOf(theme, kind), 0.12) }}>
        <Icon />
      </Box>
      <Typography sx={{ fontSize: "1rem", fontWeight: 700 }}>{t(`draft.kind.${kind}`)}</Typography>
      <Typography sx={{ fontSize: "0.84rem", color: "text.secondary", lineHeight: 1.5 }}>{t(`draft.kind.${kind}.hint`)}</Typography>
    </ButtonBase>
  );
  return (
    <Box data-testid="draft-choose" sx={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, p: 3 }}>
      <Typography component="h2" sx={{ fontSize: "1.35rem", fontWeight: 800, letterSpacing: "-0.02em", textAlign: "center" }}>
        {t("draft.choose.title")}
      </Typography>
      <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap", justifyContent: "center", width: "100%" }}>
        {card("hand", EditOutlinedIcon)}
        {card("brief", DescriptionOutlinedIcon)}
      </Box>
    </Box>
  );
}
