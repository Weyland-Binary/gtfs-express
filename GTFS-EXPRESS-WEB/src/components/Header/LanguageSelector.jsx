import React, { useState } from "react";
import {
  Box,
  IconButton,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
  Divider,
} from "@mui/material";
import { styled, useTheme } from "@mui/material/styles";
import LanguageIcon from "@mui/icons-material/Language";
import CheckIcon from "@mui/icons-material/Check";
import { useLanguage } from "../../contexts/LanguageContext";

const LangButton = styled(IconButton)(({ theme }) => ({
  padding: "6px 10px",
  borderRadius: 10,
  gap: 4,
  backgroundColor:
    theme.palette.mode === "dark"
      ? "rgba(255, 255, 255, 0.08)"
      : "rgba(25, 118, 210, 0.08)",
  color: theme.palette.primary.main,
  transition: "all 0.2s ease-in-out",
  "&:hover": {
    backgroundColor:
      theme.palette.mode === "dark"
        ? "rgba(255, 255, 255, 0.15)"
        : "rgba(25, 118, 210, 0.15)",
    transform: "scale(1.05)",
  },
}));

export default function LanguageSelector() {
  const { language, setLanguage, languages, t } = useLanguage();
  const theme = useTheme();
  const [anchorEl, setAnchorEl] = useState(null);

  const current = languages.find((l) => l.code === language) ?? languages[0];

  const handleOpen = (e) => setAnchorEl(e.currentTarget);
  const handleClose = () => setAnchorEl(null);

  const handleSelect = (code) => {
    setLanguage(code);
    handleClose();
  };

  return (
    <>
      <Tooltip title={t("language.label")}>
        <LangButton
          onClick={handleOpen}
          size="small"
          aria-label={t("language.label")}
          data-testid="language-selector"
        >
          <LanguageIcon sx={{ fontSize: 18 }} />
          <Typography
            component="span"
            sx={{
              fontSize: "0.78rem",
              fontWeight: 600,
              lineHeight: 1,
              letterSpacing: "0.01em",
              color: "inherit",
            }}
          >
            {current.code.toUpperCase()}
          </Typography>
        </LangButton>
      </Tooltip>

      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={handleClose}
        transformOrigin={{ horizontal: "right", vertical: "top" }}
        anchorOrigin={{ horizontal: "right", vertical: "bottom" }}
        PaperProps={{
          elevation: 4,
          sx: {
            minWidth: 180,
            borderRadius: 2,
            mt: 0.5,
            border:
              theme.palette.mode === "dark"
                ? "1px solid rgba(255,255,255,0.1)"
                : "1px solid rgba(0,0,0,0.08)",
            px: 0.5,
            py: 0.5,
          },
        }}
      >
        <Box sx={{ px: 1.5, py: 0.75 }}>
          <Typography
            variant="caption"
            sx={{
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "text.secondary",
              fontSize: "0.68rem",
            }}
          >
            {t("language.label")}
          </Typography>
        </Box>
        <Divider sx={{ mb: 0.5 }} />
        {languages.map((lang) => (
          <MenuItem
            key={lang.code}
            selected={lang.code === language}
            onClick={() => handleSelect(lang.code)}
            data-testid={`language-option-${lang.code}`}
            sx={{
              borderRadius: 1.5,
              fontSize: "0.875rem",
              gap: 1.5,
              px: 1.5,
              py: 0.75,
              fontWeight: lang.code === language ? 600 : 400,
              justifyContent: "space-between",
              "&.Mui-selected": {
                backgroundColor:
                  theme.palette.mode === "dark"
                    ? "rgba(144,202,249,0.12)"
                    : "rgba(25,118,210,0.08)",
              },
              "&.Mui-selected:hover": {
                backgroundColor:
                  theme.palette.mode === "dark"
                    ? "rgba(144,202,249,0.18)"
                    : "rgba(25,118,210,0.14)",
              },
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
              <span style={{ fontSize: "1.1rem", lineHeight: 1 }}>
                {lang.flag}
              </span>
              <span>{lang.label}</span>
            </Box>
            {lang.code === language && (
              <CheckIcon
                sx={{ fontSize: 16, color: "primary.main", flexShrink: 0 }}
              />
            )}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
