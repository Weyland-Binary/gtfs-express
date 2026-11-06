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
  useMediaQuery,
} from "@mui/material";
import FavoriteIcon from "@mui/icons-material/Favorite";
import CloseIcon from "@mui/icons-material/Close";
import BugReportIcon from "@mui/icons-material/BugReport";
import FavoriteBorderIcon from "@mui/icons-material/FavoriteBorder";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import EmailIcon from "@mui/icons-material/Email";
import ArrowForwardIosIcon from "@mui/icons-material/ArrowForwardIos";
import { useLanguage } from "../../contexts/LanguageContext";
import { useFeatures, requestAccessLink } from "../../utils/featuresApi";
import { useNavigate, ACCESSIBILITY_PATH, RULES_PATH, legalPath } from "../../utils/routes";
import { statusKey } from "../Accessibility";
import { PHONE } from "../../utils/layout";

const MARK_W = "1000110001101011010101010";
const MARK_B = "1111010001111101000111110";
// The publisher's logo keeps its own blue whatever the theme; the W takes the text's colour.
const BRAND_BLUE = "#0486d3";

const markCells = (bits, x0) => [...bits].flatMap((bit, i) => (bit === "1" ? [<rect key={i} x={x0 + (i % 5) * 5} y={Math.floor(i / 5) * 5} width="4" height="4" />] : []));

function PublisherMark() {
  return (
    <Box component="svg" viewBox="0 0 52 24" aria-hidden="true" data-testid="footer-publisher-mark" sx={{ width: 22, height: 10, flexShrink: 0 }}>
      <g fill="currentColor">{markCells(MARK_W, 0)}</g>
      <g fill={BRAND_BLUE}>{markCells(MARK_B, 28)}</g>
    </Box>
  );
}

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

      <Box sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1 }}>
        {contactOptions.map((opt) => (
          <Box
            key={opt.subject}
            component="a"
            href={opt.href}
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

// `compact` and widths below 1680 px keep the name and the links only, on one line, so the footer shares the status
// bar's row and the reader's overview fits the screen.
function Footer({ compact = false }) {
  const currentYear = new Date().getFullYear();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const narrow = useMediaQuery("(max-width: 1679.95px)");
  const short = compact || narrow;
  const [contactOpen, setContactOpen] = useState(false);
  const { t, language } = useLanguage();
  const navigate = useNavigate();
  // The contact address comes from the server (request_access_url), never written here.
  const { features } = useFeatures();
  const contactHref = (subject) => requestAccessLink(features?.request_access_url, { subject });
  const canContact = Boolean(contactHref("GTFS Express"));

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
  ].map((opt) => ({ ...opt, href: contactHref(opt.subject) }));

  return (
    <Box className="footer">
      <Typography
        variant="body2"
        sx={{
          color: compact ? "text.secondary" : isDark ? "#94a3b8" : "#64748b",
          display: "flex",
          whiteSpace: short ? "nowrap" : undefined,
          ...(compact ? { fontSize: "0.72rem !important", gap: "6px", "& a, & button": { color: "inherit !important" }, "& a:hover, & button:hover": { color: "text.primary" } } : {}),
          alignItems: "center",
          justifyContent: "center",
          gap: 0.5,
          fontSize: "0.7rem",
          // On a phone the links wrap instead of running off the screen.
          [PHONE]: { flexWrap: "wrap", whiteSpace: "normal", rowGap: 0, lineHeight: 2.6 },
        }}
      >
        © {currentYear}{" "}
        {!short && (
          <>
            {t("footer.madeWith")}
            <FavoriteIcon sx={{ fontSize: 16, color: "#ef4444" }} />
            by{" "}
          </>
        )}
        <PublisherMark />
        {canContact ? (
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
            Weyland-Binary
          </Link>
        ) : (
          <span>Weyland-Binary</span>
        )}{" "}
        |
        {/* The guides are static pages outside the app (/guides/, /en/guides/ for every other language). */}
        {[
          { to: legalPath("mentions-legales"), label: t("legal.tab.mentions-legales"), testid: "footer-legal-notice" },
          { to: legalPath("utilisation"), label: t("footer.conditions"), testid: "footer-terms" },
          { to: legalPath("confidentialite"), label: t("legal.tab.confidentialite"), testid: "footer-privacy" },
          { to: RULES_PATH, label: t("footer.validationRules"), testid: "footer-rules" },
          { to: language === "fr" ? "/guides/" : "/en/guides/", label: t("seo.guides"), testid: "footer-guides", page: true },
        ].map((item) => (
          <React.Fragment key={item.testid}>
            <Link
              href={item.to}
              data-testid={item.testid}
              onClick={(e) => {
                if (item.page || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                navigate(item.to);
              }}
              sx={{
                color: isDark ? "#90caf9" : "#1976d2",
                textDecoration: "none",
                fontWeight: 500,
                "&:hover": { textDecoration: "underline" },
                cursor: "pointer",
              }}
            >
              {item.label}
            </Link>{" "}
            |
          </React.Fragment>
        ))}
        {/* The accessibility statement and its status, on every screen (RGAA). */}
        <Link
          href={ACCESSIBILITY_PATH}
          data-testid="footer-accessibility"
          onClick={(e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            navigate(ACCESSIBILITY_PATH);
          }}
          sx={{
            color: isDark ? "#90caf9" : "#1565c0",
            textDecoration: "none",
            fontWeight: 500,
            "&:hover": { textDecoration: "underline" },
            cursor: "pointer",
          }}
        >
          {t("accessibility.footer", { status: t(statusKey()).toLocaleLowerCase(language) })}
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
