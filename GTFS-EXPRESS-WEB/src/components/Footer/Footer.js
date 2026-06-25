import React, { useState } from "react";
import "./Footer.css";
import {
  Typography,
  Box,
  Link,
  useTheme,
  Dialog,
  IconButton,
  Zoom,
} from "@mui/material";
import FavoriteIcon from "@mui/icons-material/Favorite";
import CloseIcon from "@mui/icons-material/Close";
import BugReportIcon from "@mui/icons-material/BugReport";
import FavoriteBorderIcon from "@mui/icons-material/FavoriteBorder";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import EmailIcon from "@mui/icons-material/Email";
import ArrowForwardIosIcon from "@mui/icons-material/ArrowForwardIos";
import { useLanguage } from "../../contexts/LanguageContext";

const CONTACT_EMAIL = "weylandbinary@gmail.com";

function ContactModal({
  open,
  onClose,
  isDark,
  contactOptions,
  title,
  subtitle,
  emailNote,
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      TransitionComponent={Zoom}
      TransitionProps={{ timeout: 220 }}
      PaperProps={{
        sx: {
          backgroundColor: isDark ? "#0f172a" : "#ffffff",
          borderRadius: "20px",
          overflow: "hidden",
          boxShadow: isDark
            ? "0 24px 48px rgba(0,0,0,0.6)"
            : "0 24px 48px rgba(15,23,42,0.15)",
          border: "none",
          m: 2,
        },
      }}
      slotProps={{
        backdrop: {
          sx: {
            backgroundColor: isDark ? "rgba(0,0,0,0.7)" : "rgba(15,23,42,0.4)",
            backdropFilter: "blur(4px)",
          },
        },
      }}
    >
      {/* Header gradient */}
      <Box
        sx={{
          background: "linear-gradient(135deg, #1565c0 0%, #42a5f5 100%)",
          pt: 4,
          pb: 3.5,
          px: 3,
          position: "relative",
          textAlign: "center",
        }}
      >
        <IconButton
          onClick={onClose}
          size="small"
          sx={{
            position: "absolute",
            top: 12,
            right: 12,
            color: "rgba(255,255,255,0.65)",
            "&:hover": {
              color: "#fff",
              backgroundColor: "rgba(255,255,255,0.15)",
            },
          }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>

        <Box
          sx={{
            width: 56,
            height: 56,
            borderRadius: "16px",
            backgroundColor: "rgba(255,255,255,0.2)",
            backdropFilter: "blur(8px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            mx: "auto",
            mb: 2,
            border: "1px solid rgba(255,255,255,0.3)",
          }}
        >
          <EmailIcon sx={{ color: "#fff", fontSize: 26 }} />
        </Box>

        <Typography
          variant="h6"
          fontWeight={700}
          sx={{ color: "#fff", letterSpacing: "-0.01em", mb: 0.5 }}
        >
          {title}
        </Typography>
        <Typography
          variant="caption"
          sx={{ color: "rgba(255,255,255,0.72)", display: "block" }}
        >
          {subtitle}
        </Typography>
      </Box>

      {/* Options */}
      <Box sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1 }}>
        {contactOptions.map((opt) => (
          <Box
            key={opt.subject}
            component="a"
            href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(opt.subject)}`}
            onClick={onClose}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              p: "14px 16px",
              borderRadius: "12px",
              border: `1px solid ${isDark ? "#1e293b" : "#f1f5f9"}`,
              backgroundColor: isDark ? "#1e293b" : "#f8fafc",
              cursor: "pointer",
              textDecoration: "none",
              transition: "all 0.18s cubic-bezier(0.4, 0, 0.2, 1)",
              "&:hover": {
                borderColor: opt.color,
                backgroundColor: isDark ? "rgba(255,255,255,0.04)" : "#ffffff",
                transform: "translateX(4px)",
                boxShadow: `0 4px 16px ${opt.color}28`,
              },
            }}
          >
            <Box
              sx={{
                width: 40,
                height: 40,
                borderRadius: "10px",
                backgroundColor: `${opt.color}18`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                color: opt.color,
              }}
            >
              {opt.icon}
            </Box>

            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="body2"
                fontWeight={600}
                sx={{
                  color: isDark ? "#e2e8f0" : "#1e293b",
                  lineHeight: 1.3,
                }}
              >
                {opt.label}
              </Typography>
              <Typography
                variant="caption"
                sx={{
                  color: isDark ? "#64748b" : "#94a3b8",
                  display: "block",
                  mt: 0.2,
                }}
              >
                {opt.description}
              </Typography>
            </Box>

            <ArrowForwardIosIcon
              sx={{
                fontSize: 11,
                color: isDark ? "#334155" : "#cbd5e1",
                flexShrink: 0,
              }}
            />
          </Box>
        ))}
      </Box>

      {/* Footer note */}
      <Box sx={{ textAlign: "center", pb: 2.5, px: 3, pt: 0 }}>
        <Typography
          variant="caption"
          sx={{ color: isDark ? "#334155" : "#cbd5e1" }}
        >
          {emailNote}
        </Typography>
      </Box>
    </Dialog>
  );
}

function Footer() {
  const currentYear = new Date().getFullYear();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const [contactOpen, setContactOpen] = useState(false);
  const { t } = useLanguage();

  const contactOptions = [
    {
      icon: <BugReportIcon sx={{ fontSize: 20 }} />,
      label: t("footer.reportBug"),
      description: t("footer.reportBugDesc"),
      subject: "[Bug] GTFS Express",
      color: "#ef4444",
    },
    {
      icon: <FavoriteBorderIcon sx={{ fontSize: 20 }} />,
      label: t("footer.kindWord"),
      description: t("footer.kindWordDesc"),
      subject: "[Encouragement] GTFS Express",
      color: "#ec4899",
    },
    {
      icon: <HelpOutlineIcon sx={{ fontSize: 20 }} />,
      label: t("footer.askQuestion"),
      description: t("footer.askQuestionDesc"),
      subject: "[Question] GTFS Express",
      color: "#3b82f6",
    },
  ];

  return (
    <Box className="footer">
      <Typography
        variant="body2"
        sx={{
          color: isDark ? "#94a3b8" : "#64748b",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 0.5,
          fontSize: "0.7rem",
        }}
      >
        © {currentYear} {t("footer.madeWith")}
        <FavoriteIcon sx={{ fontSize: 16, color: "#ef4444" }} />
        by{" "}
        <Link
          component="button"
          onClick={() => setContactOpen(true)}
          sx={{
            color: isDark ? "#90caf9" : "#1976d2",
            textDecoration: "none",
            fontWeight: 500,
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: "inherit",
            fontFamily: "inherit",
            p: 0,
            "&:hover": { textDecoration: "underline" },
          }}
        >
          Weyland Binary
        </Link>{" "}
        |
        <Link
          href="#cgu"
          onClick={(e) => {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent("showCGU"));
          }}
          sx={{
            color: isDark ? "#90caf9" : "#1976d2",
            textDecoration: "none",
            fontWeight: 500,
            "&:hover": { textDecoration: "underline" },
            cursor: "pointer",
          }}
        >
          {t("footer.termsOfUse")}
        </Link>{" "}
        |
        <Link
          href="https://gtfs-validator.mobilitydata.org/rules.html"
          target="_blank"
          rel="noopener noreferrer"
          sx={{
            color: isDark ? "#90caf9" : "#1976d2",
            textDecoration: "none",
            fontWeight: 500,
            "&:hover": { textDecoration: "underline" },
            cursor: "pointer",
          }}
        >
          {t("footer.validationRules")}
        </Link>
      </Typography>

      <ContactModal
        open={contactOpen}
        onClose={() => setContactOpen(false)}
        isDark={isDark}
        contactOptions={contactOptions}
        title={t("footer.getInTouch")}
        subtitle={t("footer.getInTouchSub")}
        emailNote={t("footer.emailNote")}
      />
    </Box>
  );
}

export default Footer;
