import React, { useState } from "react";
import "./Footer.css";
import {
  Typography,
  Box,
  Link,
  useTheme,
  Dialog,
  DialogActions,
  DialogContent,
  alpha,
  useMediaQuery,
} from "@mui/material";
import FavoriteIcon from "@mui/icons-material/Favorite";
import BugReportIcon from "@mui/icons-material/BugReport";
import FavoriteBorderIcon from "@mui/icons-material/FavoriteBorder";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import EmailIcon from "@mui/icons-material/Email";
import ArrowForwardIosIcon from "@mui/icons-material/ArrowForwardIos";
import { useLanguage } from "../../contexts/LanguageContext";
import DialogHeader from "../common/DialogHeader";
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
  contactOptions,
  title,
  subtitle,
  emailNote,
}) {
  const theme = useTheme();
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogHeader icon={<EmailIcon />} title={title} subtitle={subtitle} onClose={onClose} />
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {contactOptions.map((opt) => (
          <Box
            key={opt.subject}
            component="a"
            href={opt.href}
            onClick={onClose}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.75,
              p: "12px 14px",
              borderRadius: "12px",
              border: `1px solid ${theme.palette.divider}`,
              cursor: "pointer",
              textDecoration: "none",
              transition: "border-color .15s, background-color .15s",
              "&:hover": { borderColor: opt.color, backgroundColor: alpha(opt.color, 0.04) },
            }}
          >
            <Box
              sx={{
                width: 36,
                height: 36,
                borderRadius: "10px",
                backgroundColor: alpha(opt.color, 0.1),
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
              <Typography sx={{ fontSize: 14, fontWeight: 600, color: "text.primary", lineHeight: 1.3 }}>{opt.label}</Typography>
              <Typography sx={{ fontSize: 12.5, color: "text.secondary", mt: 0.25 }}>{opt.description}</Typography>
            </Box>
            <ArrowForwardIosIcon sx={{ fontSize: 11, color: "text.disabled", flexShrink: 0 }} />
          </Box>
        ))}
      </DialogContent>
      <DialogActions>
        <Typography sx={{ mr: "auto", fontSize: 12, color: "text.secondary" }}>{emailNote}</Typography>
      </DialogActions>
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
        contactOptions={contactOptions}
        title={t("footer.getInTouch")}
        subtitle={t("footer.getInTouchSub")}
        emailNote={t("footer.emailNote")}
      />
    </Box>
  );
}

export default Footer;
