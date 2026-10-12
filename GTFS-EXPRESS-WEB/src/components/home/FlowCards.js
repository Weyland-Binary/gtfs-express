/**
 * FlowCards — what people come to do, first on Home (target design §4 A0,
 * the former LandingJourneys): three cards in one `landing-journeys` nav —
 *
 *   modify   "Modifier un réseau" (`landing-modify-network`): the published
 *            network of one's territory, or one's own file, changed without
 *            losing anything → /modifier, the project's ① where the network
 *            is chosen
 *   create   "Concevoir un réseau" (`uploader-create-network`): from a
 *            territory or a brief to a GTFS that passes the validation, in
 *            5 steps → /creer
 *   explore  "Explorer un réseau" (the ExplorerCard the host passes): drop a
 *            GTFS or open the demo, free reading without an account
 *
 * Each card says its gate before any work (`gate-hint`: reading free, the
 * assistant, what applying or delivering needs), read from the server's
 * access object (featuresApi.gateHint, D30: the Studio gates the assistant,
 * never "modify").
 *
 * Under the paid offer (featuresApi.paidLockOf) the two journeys are the
 * subscription's: without it each card wears the plan's badge
 * (`flow-plan-badge`) and leads to the offer (openPaywall) instead of a
 * project the server would refuse; exploring stays free and open.
 *
 *   StudiosSection  the two studios by name, and what the AI does — part of
 *                   Home's folded "En savoir plus" (LearnMore).
 */

import React from "react";
import { Box, ButtonBase, Typography, alpha, useTheme } from "@mui/material";
import EditRoadOutlinedIcon from "@mui/icons-material/EditRoadOutlined";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import TravelExploreOutlinedIcon from "@mui/icons-material/TravelExploreOutlined";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import AutoFixHighOutlinedIcon from "@mui/icons-material/AutoFixHighOutlined";
import BuildCircleOutlinedIcon from "@mui/icons-material/BuildCircleOutlined";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import TipsAndUpdatesOutlinedIcon from "@mui/icons-material/TipsAndUpdatesOutlined";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import HowToRegOutlinedIcon from "@mui/icons-material/HowToRegOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { gateHint, openPaywall, paidLockOf, useFeatures } from "../../utils/featuresApi";

const surfaceOf = (theme) => (theme.palette.mode === "dark" ? "#132f4c" : "#ffffff");
const borderOf = (theme) => (theme.palette.mode === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)");

const cardSx = (theme, accent) => ({
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  textAlign: "left",
  gap: 1.1,
  width: "100%",
  height: "100%",
  p: { xs: 2, md: 2.25 },
  borderRadius: "18px",
  border: `1px solid ${alpha(accent, 0.35)}`,
  background: `linear-gradient(135deg, ${alpha(accent, theme.palette.mode === "dark" ? 0.16 : 0.07)}, ${surfaceOf(theme)} 60%)`,
  boxShadow: theme.palette.mode === "dark" ? "0 8px 32px rgba(0,0,0,0.4)" : "0 8px 32px rgba(15,23,42,0.08)",
});

function CardHead({ icon: Icon, gradient, title, text }) {
  return (
    <>
      <Box sx={{ width: 44, height: 44, borderRadius: "13px", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", background: gradient }}>
        <Icon sx={{ fontSize: 24 }} />
      </Box>
      <Typography component="span" sx={{ fontWeight: 800, fontSize: { xs: "1.02rem", md: "1.08rem" }, lineHeight: 1.25, color: "text.primary" }}>
        {title}
      </Typography>
      <Typography component="span" sx={{ fontSize: "0.84rem", lineHeight: 1.55, color: "text.secondary", flex: 1 }}>
        {text}
      </Typography>
    </>
  );
}

const Hint = ({ children }) =>
  children ? (
    <Typography component="span" data-testid="gate-hint" sx={{ fontSize: "0.72rem", lineHeight: 1.45, color: "text.secondary", fontWeight: 600 }}>
      {children}
    </Typography>
  ) : null;

/** A card that is one button: the whole card leads to the flow. */
function FlowCard({ icon, title, text, hint = null, cta, gradient, accent, onClick, testid, locked = false, badge = null }) {
  const theme = useTheme();
  return (
    <ButtonBase
      onClick={onClick}
      data-testid={testid}
      sx={{
        ...cardSx(theme, accent),
        position: "relative",
        transition: "transform 0.25s cubic-bezier(0.4,0,0.2,1), box-shadow 0.25s, border-color 0.25s",
        "&:hover": { transform: "translateY(-2px)", borderColor: alpha(accent, 0.7), boxShadow: `0 12px 36px ${alpha(accent, theme.palette.mode === "dark" ? 0.3 : 0.2)}` },
        "&:focus-visible": { outline: `3px solid ${alpha(accent, 0.5)}`, outlineOffset: 2 },
      }}
    >
      {badge && (
        <Box component="span" data-testid="flow-plan-badge" sx={{ position: "absolute", top: 14, right: 14, display: "inline-flex", alignItems: "center", gap: 0.4, height: 22, px: 1, borderRadius: 999, fontSize: "0.68rem", fontWeight: 800, letterSpacing: 0.2, color: accent, backgroundColor: alpha(accent, theme.palette.mode === "dark" ? 0.2 : 0.1), border: `1px solid ${alpha(accent, 0.35)}` }}>
          <LockOutlinedIcon sx={{ fontSize: 13 }} />
          {badge}
        </Box>
      )}
      <CardHead icon={icon} gradient={gradient} title={title} text={text} />
      <Hint>{hint}</Hint>
      <Box component="span" data-locked={locked ? "true" : undefined} sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontSize: "0.84rem", fontWeight: 800, color: accent }}>
        {cta}
        <ArrowForwardRoundedIcon sx={{ fontSize: 18 }} />
      </Box>
    </ButtonBase>
  );
}

/**
 * The three flows. `explorer` is the explore card's body (the drop zone and
 * the demo, ExplorerCard); without it the card is left out.
 */
export default function FlowCards({ onModify = null, onCreate = null, explorer = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const { features } = useFeatures();
  const access = features?.access || null;
  const primary = theme.palette.mode === "dark" ? "#60a5fa" : theme.palette.primary.main;
  const explore = theme.palette.mode === "dark" ? "#34d399" : "#059669";
  const count = [onModify, onCreate, explorer].filter(Boolean).length;
  if (!count) return null;
  // The two journeys side by side on the first row, their buttons in sight on a laptop screen; exploring (a drop
  // zone, the demo) spans the row under them. Three equal columns stretched the journeys' cards to the drop zone's
  // height and pushed « Trouver mon réseau » and « Commencer » below the fold at 1440 × 900.
  const journeys = [onModify, onCreate].filter(Boolean).length;
  // The paid offer: without the subscription, both journeys open the offer (what was asked is said there).
  const lock = paidLockOf(access, "studio");
  const locked = lock === "sign_in_required" || lock === "subscription_required";
  const paidCard = locked ? { locked: true, badge: t("paywall.badge"), cta: t("paywall.cta.seePlans") } : {};
  const toModify = locked ? () => openPaywall("studio", lock) : onModify;
  const toCreate = locked ? () => openPaywall("studio", lock) : onCreate;
  return (
    <>
      <Box component="nav" aria-label={t("home.question")} data-testid="landing-journeys" sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: count > 1 ? "1fr 1fr" : "1fr" }, gap: { xs: 1.5, md: 2 }, alignItems: "stretch" }}>
        {onModify && <FlowCard icon={EditRoadOutlinedIcon} title={t("flow.modify.title")} text={t("flow.modify.text")} hint={gateHint("modify", access, t)} cta={t("landing.modify.cta")} gradient={`linear-gradient(135deg, ${theme.palette.primary.main}, ${theme.palette.primary.dark})`} accent={primary} onClick={toModify} testid="landing-modify-network" {...paidCard} />}
        {onCreate && <FlowCard icon={AutoAwesomeIcon} title={t("flow.create.title")} text={t("flow.create.text")} hint={gateHint("create", access, t)} cta={t("flow.start")} gradient={`linear-gradient(135deg, ${theme.palette.ai.gradientStart}, ${theme.palette.ai.gradientEnd})`} accent={theme.palette.ai.main} onClick={toCreate} testid="uploader-create-network" {...paidCard} />}
        {explorer && (
          <Box component="section" aria-label={t("flow.explore.title")} data-testid="flow-explore" sx={{ ...cardSx(theme, explore), gridColumn: { sm: journeys === 1 ? "auto" : "1 / -1" } }}>
            <CardHead icon={TravelExploreOutlinedIcon} gradient={`linear-gradient(135deg, ${explore}, ${alpha(explore, 0.75)})`} title={t("flow.explore.title")} text={t("flow.explore.text")} />
            <Hint>{gateHint("explore", access, t)}</Hint>
            <Box sx={{ width: "100%" }}>{explorer}</Box>
          </Box>
        )}
      </Box>
    </>
  );
}

const AI_STEPS = [
  { key: "read", icon: MenuBookOutlinedIcon },
  { key: "propose", icon: TipsAndUpdatesOutlinedIcon },
  { key: "check", icon: FactCheckOutlinedIcon },
  { key: "you", icon: HowToRegOutlinedIcon },
];

export function StudiosSection() {
  const { t } = useLanguage();
  const theme = useTheme();
  const studios = [
    { key: "change", icon: AutoFixHighOutlinedIcon, color: theme.palette.primary.main },
    { key: "network", icon: BuildCircleOutlinedIcon, color: theme.palette.ai.main },
  ];
  return (
    <Box component="section" data-testid="landing-studios" sx={{ maxWidth: 880, mx: "auto", mb: 6, px: { xs: 0.5, sm: 0 } }}>
      <Typography component="h2" sx={{ fontWeight: 800, fontSize: { xs: "1.15rem", md: "1.3rem" }, textAlign: "center", lineHeight: 1.3 }}>
        {t("landing.studios.title")}
      </Typography>
      <Typography sx={{ fontSize: "0.88rem", color: "text.secondary", textAlign: "center", mt: 0.5, mb: 2.5, lineHeight: 1.55 }}>{t("landing.studios.subtitle")}</Typography>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 1.5 }}>
        {studios.map(({ key, icon: Icon, color }) => (
          <Box key={key} data-testid={`landing-studio-${key}`} sx={{ p: 2, borderRadius: "14px", border: `1px solid ${borderOf(theme)}`, background: surfaceOf(theme) }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.75 }}>
              <Box sx={{ width: 32, height: 32, borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center", color, background: alpha(color, 0.12) }}>
                <Icon sx={{ fontSize: 18 }} />
              </Box>
              <Typography component="h3" sx={{ fontWeight: 800, fontSize: "0.95rem" }}>
                {t(`landing.studio.${key}.name`)}
              </Typography>
            </Box>
            <Typography sx={{ fontSize: "0.82rem", color: "text.secondary", lineHeight: 1.55 }}>{t(`landing.studio.${key}.text`)}</Typography>
          </Box>
        ))}
      </Box>
      <Typography component="h3" sx={{ fontWeight: 800, fontSize: "0.9rem", mt: 3, mb: 1.25, textAlign: "center" }}>
        {t("landing.ai.title")}
      </Typography>
      <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", md: "repeat(4, 1fr)" }, gap: 1.25 }}>
        {AI_STEPS.map(({ key, icon: Icon }, i) => (
          <Box component="li" key={key} data-testid={`landing-ai-${key}`} sx={{ display: "flex", gap: 1, alignItems: "flex-start", p: 1.5, borderRadius: "12px", background: alpha(theme.palette.ai.main, theme.palette.mode === "dark" ? 0.1 : 0.05) }}>
            <Box sx={{ width: 26, height: 26, flexShrink: 0, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", color: theme.palette.ai.main, background: alpha(theme.palette.ai.main, 0.14), fontSize: "0.72rem", fontWeight: 800 }} aria-hidden>
              <Icon sx={{ fontSize: 15 }} />
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontSize: "0.8rem", fontWeight: 800, lineHeight: 1.3 }}>
                {i + 1}. {t(`landing.ai.${key}.title`)}
              </Typography>
              <Typography sx={{ fontSize: "0.74rem", color: "text.secondary", lineHeight: 1.45, mt: 0.25 }}>{t(`landing.ai.${key}.text`)}</Typography>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
