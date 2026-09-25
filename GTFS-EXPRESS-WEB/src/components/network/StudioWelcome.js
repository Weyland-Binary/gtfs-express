/**
 * StudioWelcome — the empty map's invitation: three ways to start a
 * network (analyse a territory, drop a specification, describe the
 * network), freely combined. The card also accepts a dropped document.
 */

import React, { useRef, useState } from "react";
import { Box, ButtonBase, Typography, alpha, useTheme } from "@mui/material";
import TravelExploreOutlinedIcon from "@mui/icons-material/TravelExploreOutlined";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import ChatOutlinedIcon from "@mui/icons-material/ChatOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { BRIEF_ACCEPT } from "../../utils/networkStudioApi";
import { soft } from "./StudioUI";

export default function StudioWelcome({ onTerritory, onAttach, onDescribe, canAttach = true }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const fileRef = useRef(null);
  const [over, setOver] = useState(false);
  const actions = [
    { key: "territory", icon: TravelExploreOutlinedIcon, color: theme.palette.info.main, onClick: onTerritory },
    { key: "brief", icon: UploadFileOutlinedIcon, color: "#D32F2F", onClick: () => fileRef.current?.click(), disabled: !canAttach },
    { key: "describe", icon: ChatOutlinedIcon, color: theme.palette.ai.main, onClick: onDescribe },
  ];
  return (
    <Box
      data-testid="studio-welcome"
      onDragOver={(e) => {
        if (canAttach && Array.from(e.dataTransfer?.types || []).includes("Files")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (canAttach && e.dataTransfer?.files?.length) onAttach(Array.from(e.dataTransfer.files));
      }}
      sx={{ width: "min(640px, calc(100% - 32px))", p: { xs: 2, sm: 3 }, borderRadius: "18px", background: alpha(theme.palette.background.paper, 0.96), backdropFilter: "blur(8px)", boxShadow: theme.palette.mode === "dark" ? "0 20px 50px rgba(0,0,0,0.5)" : "0 20px 50px rgba(15,23,42,0.14)", outline: over ? `2px dashed ${theme.palette.primary.main}` : "none", outlineOffset: -8 }}
    >
      <Typography sx={{ fontSize: "1.25rem", fontWeight: 800, lineHeight: 1.25 }}>{t("network.welcome.title")}</Typography>
      <Typography sx={{ fontSize: "0.84rem", color: "text.secondary", mt: 0.5, lineHeight: 1.5 }}>{t("network.welcome.subtitle")}</Typography>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(3, 1fr)" }, gap: 1.25, mt: 2 }}>
        {actions.map(({ key, icon: Icon, color, onClick, disabled }) => (
          <ButtonBase
            key={key}
            onClick={onClick}
            disabled={disabled}
            data-testid={`welcome-${key}`}
            sx={{ display: "flex", flexDirection: "column", alignItems: "flex-start", textAlign: "left", gap: 0.75, p: 1.5, borderRadius: "14px", background: soft(theme), transition: "background 120ms, transform 120ms", "&:hover": { background: soft(theme, 2), transform: "translateY(-1px)" }, "&.Mui-disabled": { opacity: 0.5 } }}
          >
            <Box sx={{ width: 34, height: 34, borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center", color, background: alpha(color, 0.12) }}>
              <Icon sx={{ fontSize: 19 }} />
            </Box>
            <Typography sx={{ fontSize: "0.86rem", fontWeight: 800, lineHeight: 1.25 }}>{t(`network.welcome.${key}`)}</Typography>
            <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.45 }}>{t(`network.welcome.${key}Hint`)}</Typography>
          </ButtonBase>
        ))}
      </Box>
      <Typography sx={{ fontSize: "0.7rem", color: "text.disabled", mt: 1.5 }}>{t("network.docs.privacy")}</Typography>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={BRIEF_ACCEPT}
        hidden
        data-testid="welcome-file"
        onChange={(e) => {
          if (e.target.files?.length) onAttach(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
    </Box>
  );
}
