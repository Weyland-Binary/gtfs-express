/**
 * The top bar of a phone's pages (its Home, the legal and content pages): the brand that leads Home, the account, and
 * a menu from the bottom of the screen for the language, the theme and the legal pages. It sticks to the top and keeps
 * clear of a notch.
 */

import React, { useState } from "react";
import { Box, ButtonBase, Divider, Drawer, IconButton, Link, Typography, alpha, useTheme } from "@mui/material";
import { visuallyHidden } from "../common/StatusBar";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import MenuRoundedIcon from "@mui/icons-material/MenuRounded";
import DarkModeOutlinedIcon from "@mui/icons-material/DarkModeOutlined";
import LogoSvg from "../../assets/LogoSvg";
import { useLanguage } from "../../contexts/LanguageContext";
import { useThemeMode } from "../../contexts/ThemeContext";
import { useAccount } from "../../contexts/AccountContext";
import { useNavigate, ACCESSIBILITY_PATH, HOME_PATH, RULES_PATH, legalPath } from "../../utils/routes";
import { statusKey } from "../Accessibility";
import AccountMenu from "../account/AccountMenu";

/** The legal and content pages, as the footer lists them; the guides are static pages outside the app. */
export const pageLinksOf = (t, language) => [
  { to: legalPath("mentions-legales"), label: t("legal.tab.mentions-legales"), testid: "mobile-link-legal-notice" },
  { to: legalPath("utilisation"), label: t("footer.conditions"), testid: "mobile-link-terms" },
  { to: legalPath("confidentialite"), label: t("legal.tab.confidentialite"), testid: "mobile-link-privacy" },
  { to: RULES_PATH, label: t("footer.validationRules"), testid: "mobile-link-rules" },
  { to: language === "fr" ? "/guides/" : "/en/guides/", label: t("seo.guides"), testid: "mobile-link-guides", page: true },
  { to: ACCESSIBILITY_PATH, label: t("accessibility.footer", { status: t(statusKey()).toLocaleLowerCase(language) }), testid: "mobile-link-accessibility" },
];

/** A link of the app's own router, a static page left to the browser. */
export function PageLink({ link, onGo = null, sx = {} }) {
  const navigate = useNavigate();
  return (
    <Link
      href={link.to}
      data-testid={link.testid}
      underline="none"
      onClick={(e) => {
        onGo?.();
        if (link.page || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(link.to);
      }}
      sx={{ minHeight: 44, display: "inline-flex", alignItems: "center", fontWeight: 500, ...sx }}
    >
      {link.label}
    </Link>
  );
}

function MenuSheet({ open, onClose }) {
  const theme = useTheme();
  const { t, language, setLanguage, languages } = useLanguage();
  const { toggleMode, isDark } = useThemeMode();
  return (
    <Drawer anchor="bottom" open={open} onClose={onClose} data-testid="mobile-menu" PaperProps={{ role: "dialog", "aria-modal": true, "aria-labelledby": "mobile-menu-title", sx: { borderRadius: "18px 18px 0 0", px: 2.5, pt: 1, pb: "max(20px, env(safe-area-inset-bottom))", maxHeight: "88dvh" } }}>
      <Typography id="mobile-menu-title" component="h2" sx={visuallyHidden}>
        {t("mobile.menu")}
      </Typography>
      <Box aria-hidden sx={{ width: 40, height: 5, borderRadius: 3, bgcolor: "divider", mx: "auto", mb: 2 }} />
      <Typography component="h2" sx={{ fontSize: "0.8rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "text.secondary", mb: 1 }}>
        {t("language.label")}
      </Typography>
      <Box role="group" aria-label={t("language.label")} sx={{ display: "flex", flexWrap: "wrap", gap: 1, mb: 2 }}>
        {languages.map((l) => {
          const on = l.code === language;
          return (
            <ButtonBase
              key={l.code}
              lang={l.code}
              aria-pressed={on}
              onClick={() => setLanguage(l.code)}
              data-testid={`mobile-language-${l.code}`}
              sx={{ minHeight: 44, px: 2, borderRadius: 999, fontSize: "0.95rem", fontWeight: on ? 700 : 500, color: on ? "primary.contrastText" : "text.primary", backgroundColor: on ? theme.palette.primary.main : alpha(theme.palette.text.primary, 0.06) }}
            >
              {l.label}
            </ButtonBase>
          );
        })}
      </Box>
      <ButtonBase onClick={toggleMode} role="switch" aria-checked={isDark} data-testid="theme-toggle" data-mode={isDark ? "dark" : "light"} sx={{ width: "100%", minHeight: 52, display: "flex", alignItems: "center", gap: 1.5, borderRadius: 2, textAlign: "left" }}>
        <DarkModeOutlinedIcon sx={{ color: "text.secondary" }} />
        <Typography sx={{ flex: 1, fontSize: "1rem" }}>{t("header.darkMode")}</Typography>
        {/* Drawn, not a control: the button is the switch. */}
        <Box aria-hidden sx={{ position: "relative", width: 38, height: 22, flexShrink: 0, borderRadius: 11, backgroundColor: isDark ? theme.palette.primary.main : alpha(theme.palette.text.primary, 0.26), transition: "background-color .2s" }}>
          <Box sx={{ position: "absolute", top: 3, left: isDark ? 19 : 3, width: 16, height: 16, borderRadius: "50%", backgroundColor: theme.palette.common.white, boxShadow: `0 1px 3px ${alpha(theme.palette.common.black, 0.3)}`, transition: "left .2s", "@media (prefers-reduced-motion: reduce)": { transition: "none" } }} />
        </Box>
      </ButtonBase>
      <Divider sx={{ my: 1.5 }} />
      <Box component="nav" aria-label={t("a11y.legalNav")} sx={{ display: "flex", flexDirection: "column" }}>
        {pageLinksOf(t, language).map((link) => (
          <PageLink key={link.testid} link={link} onGo={onClose} sx={{ fontSize: "1rem" }} />
        ))}
      </Box>
    </Drawer>
  );
}

export default function MobileBar() {
  const theme = useTheme();
  const { t } = useLanguage();
  const { isDark } = useThemeMode();
  const { enabled, me, openAccountDialog } = useAccount();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const iconSx = { width: 44, height: 44, borderRadius: "12px" };
  return (
    <>
      <Box
        component="header"
        data-testid="mobile-bar"
        sx={{
          position: "sticky",
          top: 0,
          zIndex: theme.zIndex.appBar,
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          minHeight: 60,
          pt: "env(safe-area-inset-top)",
          pl: "max(12px, env(safe-area-inset-left))",
          pr: "max(8px, env(safe-area-inset-right))",
          backgroundColor: theme.palette.background.paper,
          borderBottom: `1px solid ${theme.palette.divider}`,
        }}
      >
        <Box
          component="a"
          href={HOME_PATH}
          aria-label={t("studio.home")}
          onClick={(e) => {
            e.preventDefault();
            navigate(HOME_PATH);
          }}
          sx={{ display: "flex", alignItems: "center", minHeight: 44, px: 0.5, borderRadius: 2 }}
        >
          <LogoSvg aria-hidden="true" style={{ width: 128, height: "auto", display: "block", overflow: "visible", color: isDark ? "#ffffff" : "#111111" }} />
        </Box>
        <Box sx={{ flex: 1 }} />
        {enabled && !me && (
          <IconButton onClick={() => openAccountDialog({ tab: "signin", from: "header" })} aria-label={t("account.signIn")} data-testid="account-signin-button" sx={{ ...iconSx, color: "primary.main", backgroundColor: alpha(theme.palette.primary.main, isDark ? 0.16 : 0.08) }}>
            <PersonOutlineIcon />
          </IconButton>
        )}
        {enabled && me && <AccountMenu compact />}
        <IconButton onClick={() => setMenu(true)} aria-label={t("mobile.menu")} aria-haspopup="dialog" data-testid="mobile-menu-open" sx={{ ...iconSx, color: "text.secondary" }}>
          <MenuRoundedIcon />
        </IconButton>
      </Box>
      <MenuSheet open={menu} onClose={() => setMenu(false)} />
    </>
  );
}
