/**
 * Home — « Mes travaux », the first screen (target design §4 A0, §9; D5,
 * D31, D39). It replaces the landing's long scroll (C12, F8). Refocused on
 * what people come for (the owner's decision of 2026-10-08): modifying a
 * network — designing one from scratch is still in development and leaves
 * Home (its address, /creer, and the command palette keep it):
 *
 *   Quel réseau voulez-vous faire évoluer ?   the one way to find a network
 *                                    on Home (FindNetworkPanel, `home-modify`):
 *                                    by town or by its file, the intent chosen
 *                                    on the network itself — « Modifier ce
 *                                    réseau » opens a new modify project at its
 *                                    ① (`onNetworkFound`, `onNetworkFile`,
 *                                    `onPickNetworkFile`), « Consulter » opens
 *                                    the reader (`onNetworkConsult`; a file
 *                                    goes to the GTFSUploader beside, which
 *                                    reads it)
 *   Découvrez le lecteur             beside it (`flow-explore`): the demo and a
 *                                    working file (the GTFSUploader without a
 *                                    zone of its own: the finder takes the
 *                                    files)
 *   Mes travaux (N)                  the projects to resume (ProjectList),
 *                                    kept on the server for this browser or
 *                                    this account
 *   Mes réseaux sans projet          the network open in this tab when no
 *                                    project owns it: explore it, or modify
 *                                    it in a project
 *   Travaux récupérés sur cet ordinateur   the working copies the browser
 *                                    saved as a safety net (IndexedDB)
 *   En savoir plus                   the product's presentation, edge to edge
 *                                    (`landing-more`, LearnMore)
 *
 * The two ways in stand side by side as panels (WayPanel), both in sight
 * without scrolling on a laptop (2026-10-08: « une présentation digne des plus
 * grands sites »), and bare (the same day: « une interface ultra intuitive et
 * dépolluée d'informations inutiles ») — a question and its actions, nothing to
 * read before acting; what is free or in the licence is said where it applies
 * (the lock on « Modifier », the offer). Everyone gets the same page (the owner's decision of
 * 2026-10-12: with works, Home had lost its head and its presentation, and the network under
 * it went faint): the hero on top (HomeHero: the title, three promises), the panels overlapping
 * its foot, the works to resume under them, then the presentation; « bêta privée » is said once, in the access line, not in the hero. The projects
 * this browser kept before the server did (the lot before WP7, localStorage
 * only) are offered once (`home-import`, D31): kept on the server with the
 * others, or left for later. Signed in with projects still owned by this
 * browser, « Rattacher mes travaux à mon compte » moves them to the account
 * (`home-attach`, the token replaced, D39). A network whose working copy the
 * server no longer holds is said in place, with the ways back
 * (`session-expired`, §7.2 f).
 */

import React, { useState } from "react";
import { Alert, Box, Button, ButtonBase, Container, Typography, useMediaQuery, useTheme } from "@mui/material";
import { keyframes } from "@mui/system";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import TravelExploreOutlinedIcon from "@mui/icons-material/TravelExploreOutlined";
import EditRoadOutlinedIcon from "@mui/icons-material/EditRoadOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useAccount } from "../../contexts/AccountContext";
import { importLegacyProjects, refreshProjects, retryLocalProjects, useLegacyProjects, useProjects } from "../../utils/projectStore";
import { attachWorkspaceToAccount } from "../../utils/projectApi";
import GTFSUploader, { READ_GTFS_FILE_EVENT } from "../GTFSUploader";
import HomeHero from "./HomeHero";
import NetworkBackdrop from "./NetworkBackdrop";
import FindNetworkPanel from "../FindNetworkPanel";
import ProjectList from "./ProjectList";
import RecoveredWorks from "./RecoveredWorks";
import LearnMore from "./LearnMore";
import { HOME_WIDTH, inkGroundOf } from "./inkGround";

// The scroll cue's chevron, a gentle nudge down (still with reduced motion).
const nudge = keyframes`
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(4px); }
`;

const panelIn = keyframes`
  from { opacity: 0; transform: translateY(14px); }
  to   { opacity: 1; transform: translateY(0); }
`;

/** The projects of the lot before (this browser only): offered once to the server (D31). */
function ImportBanner({ count }) {
  const { t } = useLanguage();
  const [later, setLater] = useState(false);
  if (!count || later) return null;
  return (
    <Alert
      severity="info"
      data-testid="home-import"
      action={
        <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
          <Button color="inherit" size="small" onClick={() => importLegacyProjects()} data-testid="home-import-accept" sx={{ textTransform: "none", fontWeight: 800 }}>
            {t("home.import.accept")}
          </Button>
          <Button color="inherit" size="small" onClick={() => setLater(true)} data-testid="home-import-later" sx={{ textTransform: "none" }}>
            {t("home.import.later")}
          </Button>
        </Box>
      }
      sx={{ alignItems: "center" }}
    >
      {t("home.import.body", { count })}
    </Alert>
  );
}

/**
 * Signed in, with projects still owned by this browser (never hidden by signing in: the server lists them
 * with the account's, `owner.via: "browser"`): move them to the account (the token replaced). Once moved,
 * every project is read again (its owner changed, not its data), and the ones the browser's quota refused
 * are offered to the server again — an account has no such quota.
 */
function AttachBanner({ count }) {
  const { t } = useLanguage();
  const account = useAccount();
  const [state, setState] = useState("idle"); // idle | busy | done | failed
  if (!account.enabled || !account.signedIn || !count || state === "done") return null;
  const attach = async () => {
    setState("busy");
    try {
      await attachWorkspaceToAccount();
      setState("done");
      await refreshProjects({ force: true });
      retryLocalProjects();
    } catch {
      setState("failed");
    }
  };
  return (
    <Alert severity={state === "failed" ? "warning" : "info"} data-testid="home-attach" action={<Button color="inherit" size="small" disabled={state === "busy"} onClick={attach} data-testid="home-attach-accept" sx={{ textTransform: "none", fontWeight: 800 }}>{t("home.attach.accept")}</Button>} sx={{ alignItems: "center" }}>
      {t(state === "failed" ? "home.attach.failed" : "home.attach.body", { count })}
    </Alert>
  );
}

/**
 * One of Home's two ways in, as a plain card (no coloured edge: the owner's remark of 2026-10-08). The two stand side
 * by side on a wide screen (modifying wider, exploring beside it), their titles on one line, both in sight without
 * scrolling.
 */
function WayPanel({ testid, children, labelledBy = undefined, component = "div", sx = {} }) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  return (
    <Box
      component={component}
      data-testid={testid}
      aria-labelledby={labelledBy}
      sx={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 1.75,
        minWidth: 0,
        px: { xs: 2, md: 3, xl: 4 },
        pt: { xs: 2.5, md: 2.75, xl: 3.5 },
        pb: { xs: 2.5, md: 2.5, xl: 3.5 },
        borderRadius: "20px",
        border: `1px solid ${theme.palette.divider}`,
        backgroundColor: theme.palette.background.paper,
        boxShadow: dark ? "0 24px 60px rgba(0,0,0,0.45)" : "0 24px 60px rgba(15, 23, 42, 0.10), 0 2px 6px rgba(15, 23, 42, 0.04)",
        overflow: "hidden",
        animation: `${panelIn} 0.5s ease-out both`,
        ...sx,
      }}
    >
      {children}
    </Box>
  );
}

export default function Home({ onUploadSuccess, onLoadSample, onProjectOpened, onModifyNetwork, onNetworkFound = null, onNetworkConsult = null, onNetworkFile = null, onPickNetworkFile = null, beforeModify = null, sampleError, openNetwork = null, sessionLost = false, onOpenProject }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const projects = useProjects();
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const legacy = useLegacyProjects();
  const owned = projects.filter((p) => !p.owner?.user_id);

  // As tall as its content, not stretched to the view: the network under it (sticky) runs down to the foot.
  // One blue ground from the head to the foot (the owner's ask of 2026-10-12, instead of paper and ink in turn): an
  // ink window as tall as the page, so the network is lit all the way down; the cards keep their paper, the loose
  // headings of the works turn white.
  const works = ["home-projects", "home-recovered", "home-networks"].map((id) => `& [data-testid="${id}"]`);
  // The first screen's height: the view less the application's bar above and its status line below.
  const FIRST_SCREEN = "min(calc(100dvh - 96px), 1180px)";
  const onInkText = { [works.map((w) => `${w} > h2, ${w} > h2 svg`).join(", ")]: { color: "rgba(255,255,255,0.86)" }, [works.map((w) => `${w} > h2 + p`).join(", ")]: { color: "rgba(255,255,255,0.72)" } };
  return (
    <Box data-testid="home" sx={{ position: "relative", width: "100%", minHeight: "100%", alignSelf: "flex-start", display: "flex", flexDirection: "column", background: theme.palette.background.default }}>
      <Box aria-hidden data-ink="true" data-testid="home-ink" sx={{ position: "absolute", inset: 0, zIndex: 0, background: inkGroundOf(theme) }} />
      {/* One network from the head to the foot, far behind the content (NetworkBackdrop: z 1, over the blue). */}
      <NetworkBackdrop reduced={reduced} />
      {/* The first screen: the head, the two panels and the way down fill the view's height (the panels take what the
          head leaves; capped so that a very tall screen keeps them in proportion). */}
      <Box data-testid="home-first-screen" sx={{ position: "relative", zIndex: 2, display: "flex", flexDirection: "column", minHeight: { md: FIRST_SCREEN } }}>
      <HomeHero />
      <Container maxWidth={false} sx={{ position: "relative", zIndex: 2, flex: { md: 1 }, flexShrink: 0, maxWidth: HOME_WIDTH, mt: { xs: -6, md: -9 }, pb: { xs: 3, md: 4 }, display: "flex", flexDirection: "column", gap: { xs: 2, md: 2.5 }, ...onInkText }}>
        {sessionLost && (
          <Alert
            severity="warning"
            data-testid="session-expired"
            action={
              <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
                <Button color="inherit" size="small" onClick={onModifyNetwork} sx={{ textTransform: "none", fontWeight: 700 }}>
                  {t("recovery.catalogue")}
                </Button>
                <Button color="inherit" size="small" onClick={() => window.dispatchEvent(new CustomEvent("gtfs:pick-gtfs-file"))} sx={{ textTransform: "none", fontWeight: 700 }}>
                  {t("recovery.upload")}
                </Button>
              </Box>
            }
          >
            <strong>{t("recovery.title")}</strong> — {t("recovery.notFound")}
          </Alert>
        )}
        <ImportBanner count={legacy.length} />
        <AttachBanner count={owned.length} />

        {/* The two ways in, side by side: modify a network (what people come for), or only read one. */}
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(0, 1.6fr) minmax(0, 1fr)" }, gap: { xs: 2, md: 2.5 }, alignItems: "stretch", flex: { md: 1 } }}>
          <WayPanel testid="home-modify">
            <FindNetworkPanel
              layout="card"
              onOpened={(result) => onNetworkFound?.(result)}
              beforeModify={beforeModify}
              onConsult={onNetworkConsult ? (result) => onNetworkConsult(result) : null}
              onUploadInstead={onPickNetworkFile}
              onDropFile={onNetworkFile}
              // A file to consult is read by the GTFSUploader beside (its phases, its refusals, the repair station).
              onReadPick={onNetworkConsult ? () => window.dispatchEvent(new CustomEvent("gtfs:pick-gtfs-file")) : null}
              onReadFile={onNetworkConsult ? (file) => window.dispatchEvent(new CustomEvent(READ_GTFS_FILE_EVENT, { detail: { file } })) : null}
              autoFocus={false}
              headingLevel="h2"
            />
          </WayPanel>
          <WayPanel testid="flow-explore" component="section" labelledBy="home-explore-title">
            <Typography id="home-explore-title" component="h2" sx={{ fontSize: { xs: "1.25rem", md: "1.5rem", xl: "1.8rem" }, fontWeight: 750, letterSpacing: "-0.02em", lineHeight: 1.2 }}>
              {t("home.try.title")}
            </Typography>
            {/* Centred in the panel's height (the first screen fills the view). */}
            <Box sx={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <GTFSUploader compact dropzone={false} onUploadSuccess={onUploadSuccess} onLoadSample={onLoadSample} onProjectOpened={onProjectOpened} sampleError={sampleError} />
            </Box>
          </WayPanel>
        </Box>
        <ProjectList projects={projects} onOpen={(p) => onOpenProject?.(p)} />
        {openNetwork && (
          <Box component="section" aria-labelledby="home-networks-title" data-testid="home-networks" sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
            <Typography id="home-networks-title" component="h2" sx={{ fontSize: "0.95rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", color: "text.secondary" }}>
              {t("home.networks")} (1)
            </Typography>
            <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1, px: 1.5, py: 1, borderRadius: "12px", border: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper }}>
              <Typography sx={{ flex: "1 1 240px", fontSize: "0.88rem", fontWeight: 700 }}>{openNetwork.name}</Typography>
              <Button size="small" startIcon={<TravelExploreOutlinedIcon />} onClick={openNetwork.onExplore} data-testid="home-network-explore" sx={{ textTransform: "none", fontWeight: 700 }}>
                {t("home.network.explore")}
              </Button>
              <Button size="small" startIcon={<EditRoadOutlinedIcon />} onClick={openNetwork.onModify} data-testid="home-network-modify" sx={{ textTransform: "none", fontWeight: 700 }}>
                {t("delivery.modifyNetwork")}
              </Button>
            </Box>
          </Box>
        )}
        <RecoveredWorks />
        {/* The way down to the presentation: a pill of the page's paper, since it stands on the head's fade. */}
        <Box sx={{ display: "flex", justifyContent: "center", mt: { xs: 0.5, md: 0 } }}>
          <ButtonBase onClick={() => document.getElementById("learn-more")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" })} data-testid="home-discover" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, pl: { xs: 2, xl: 2.75 }, pr: { xs: 1.25, xl: 1.75 }, height: { xs: 38, xl: 48 }, borderRadius: 999, fontSize: { xs: "0.86rem", xl: "1rem" }, fontWeight: 650, color: "text.secondary", border: `1px solid ${theme.palette.divider}`, backgroundColor: theme.palette.background.paper, boxShadow: theme.palette.mode === "dark" ? "0 6px 18px rgba(0,0,0,0.35)" : "0 6px 18px rgba(15, 23, 42, 0.08)", transition: "color 200ms, border-color 200ms", "&:hover": { color: "text.primary", borderColor: theme.palette.primary.main } }}>
            {t("home.discover")}
            <ExpandMoreIcon sx={{ fontSize: 20, ...(reduced ? {} : { animation: `${nudge} 1.8s ease-in-out infinite` }) }} />
          </ButtonBase>
        </Box>
      </Container>
      </Box>
      {/* The presentation, edge to edge, on the page's blue (its parts draw no ground of their own): outside the
          column above, which is a plane of its own over the network. */}
      <Box id="learn-more" component="section" aria-label={t("home.more")} data-testid="landing-more" sx={{ position: "relative", flexShrink: 0, scrollMarginTop: 72 }}>
        <LearnMore onTryDemo={onLoadSample} ink />
      </Box>
    </Box>
  );
}
