/**
 * Home — the first screen. One question, « Quel réseau voulez-vous explorer
 * ou modifier ? » (HomeHero's title), and what follows:
 *
 *   the finder        FindNetworkPanel in its home intent (`home-find`): a
 *                     town's published networks beside the person's GTFS file;
 *                     every network found, and the file once chosen, is
 *                     « Explorer » (the reader, free: `onNetworkConsult`, the
 *                     file read by the GTFSUploader under it — its phases, its
 *                     refusals, the repair station) or « Modifier » (a new
 *                     modify project, behind the licence's gate `beforeModify`:
 *                     `onNetworkFound`, `onNetworkFile`); the demo network is
 *                     a link under the file
 *   Mes travaux (N)   the projects to resume (ProjectList), kept on the server
 *                     for this browser or this account
 *   Mes réseaux sans projet  the network open in this tab when no project owns
 *                     it: explore it, or modify it in a project
 *   En savoir plus    the product's presentation, edge to edge (`landing-more`,
 *                     LearnMore): the reader's screens are shown there, once
 *
 * The brief is asked at the project's ①, once the network is chosen: Home asks
 * one thing. What is free or in the licence is said where it applies (the lock
 * on « Modifier », the offer).
 *
 * The finder stands as one panel (WayPanel), in sight without scrolling on a laptop, and bare — a question and its
 * actions, nothing to read before acting. Everyone gets the same page, with works
 * or without (Home never loses its head, its presentation nor the network under
 * it): the hero on top (HomeHero: the title, three promises), the panel overlapping
 * its foot, the works to resume under it, then the presentation; « bêta privée » is said once, in the access line, not in the hero. The projects
 * this browser kept only in localStorage are offered once (`home-import`): kept on the server with the
 * others, or left for later. Signed in with projects still owned by this
 * browser, « Rattacher mes travaux à mon compte » moves them to the account
 * (`home-attach`, the token replaced). A network whose working copy the
 * server no longer holds is said in place, with the ways back
 * (`session-expired`).
 */

import React, { useState } from "react";
import { Alert, Box, Button, ButtonBase, Typography, useMediaQuery, useTheme } from "@mui/material";
import { keyframes } from "@mui/system";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import TravelExploreOutlinedIcon from "@mui/icons-material/TravelExploreOutlined";
import EditRoadOutlinedIcon from "@mui/icons-material/EditRoadOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useAccount } from "../../contexts/AccountContext";
import { importLegacyProjects, refreshProjects, retryLocalProjects, useLegacyProjects, useProjects } from "../../utils/projectStore";
import { attachWorkspaceToAccount } from "../../utils/projectApi";
import { licenceLockOf, useFeatures } from "../../utils/featuresApi";
import GTFSUploader, { READ_GTFS_FILE_EVENT } from "../GTFSUploader";
import HomeHero, { HomePromises, HomeTitle } from "./HomeHero";
import ReaderViewer from "./ReaderViewer";
import TryDemoButton from "./TryDemoButton";
import NetworkBackdrop from "./NetworkBackdrop";
import FindNetworkPanel from "../FindNetworkPanel";
import ProjectList from "./ProjectList";
import LearnMore from "./LearnMore";
import { inkGroundOf } from "./inkGround";

// The first screen's two pills (the demo, the way down): one shape, one height.
const FOOT_PILL = { display: "inline-flex", alignItems: "center", gap: 0.75, height: { xs: 40, xl: 48 }, borderRadius: 999, fontSize: { xs: "0.88rem", xl: "1rem" }, fontWeight: 650 };

// The scroll cue's chevron, a gentle nudge down (still with reduced motion).
const nudge = keyframes`
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(4px); }
`;

/** The projects kept only in this browser (localStorage): offered once to the server. */
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

export default function Home({ onUploadSuccess, onLoadSample, onModifyNetwork, onNetworkConsult = null, onNetworkFound = null, onNetworkFile = null, beforeModify = null, sampleError, openNetwork = null, sessionLost = false, onOpenProject }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const { features } = useFeatures();
  const lock = licenceLockOf(features?.access);
  const modifyLocked = lock === "sign_in_required" || lock === "subscription_required";
  const projects = useProjects();
  const account = useAccount();
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const legacy = useLegacyProjects();
  const owned = projects.filter((p) => !p.owner?.user_id);

  // As tall as its content, not stretched to the view: the network under it (sticky) runs down to the foot.
  // One blue ground from the head to the foot (never paper and ink in turn): an
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
      {/* The first screen: the head (its content centred in the height the rest leaves), the works and the way down at
          the foot fill the view's height (capped so that a very tall screen keeps them in proportion). */}
      <Box data-testid="home-first-screen" sx={{ position: "relative", zIndex: 2, display: "flex", flexDirection: "column", minHeight: { md: FIRST_SCREEN } }}>
      <HomeHero>
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

        <Box data-testid="home-find">
          <FindNetworkPanel
            intent="home"
            heading={<HomeTitle />}
            aside={<ReaderViewer />}
            onConsult={(result) => onNetworkConsult?.(result)}
            onOpened={(result) => onNetworkFound?.(result)}
            beforeModify={beforeModify}
            modifyLocked={modifyLocked}
            // The file explored is read by the GTFSUploader under the target (its phases, its refusals, the repair
            // station): the target hands it over. The file modified opens a new project.
            onExploreFile={(file) => window.dispatchEvent(new CustomEvent(READ_GTFS_FILE_EVENT, { detail: { file } }))}
            onModifyFile={(file) => onNetworkFile?.(file)}
            fileFoot={<GTFSUploader compact dropzone={false} onUploadSuccess={onUploadSuccess} onLoadSample={onLoadSample} sampleError={sampleError} />}
            autoFocus={false}
            labelledBy="home-title"
          />
        </Box>
        {/* The head, the promise, the works and the way down: one group the first screen centres on the head's blue —
            the promise as close to the cards as to what follows. */}
        <Box data-testid="home-trust" sx={{ flexShrink: 0, pt: { xs: 1, md: 0 }, pb: { xs: 1, md: 3 }, mt: { md: -4 }, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <HomePromises />
        </Box>
        <Box sx={{ display: "flex", flexDirection: "column", gap: { xs: 2, md: 2.5 }, ...onInkText }}>
          {/* Signed in, « Mes travaux » is the account menu's (its count on the avatar); a visitor's stay here. */}
          {!(account.enabled && account.signedIn) && <ProjectList projects={projects} onOpen={(p) => onOpenProject?.(p)} />}
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
          {/* The first screen's foot: the demo network to explore at once (the page's paper, the primary of the two) and the
              way down to the presentation (an outline on the blue). */}
          <Box data-testid="home-actions" sx={{ display: "flex", justifyContent: "center", alignItems: "center", flexWrap: "wrap", gap: 1.5, mt: { xs: 0.5, md: 0 } }}>
            <TryDemoButton
              onTryDemo={onLoadSample}
              sx={{ ...FOOT_PILL, px: { xs: 2.25, xl: 3 }, color: "primary.main", backgroundColor: theme.palette.background.paper, boxShadow: theme.palette.mode === "dark" ? "0 6px 18px rgba(0,0,0,0.35)" : "0 6px 18px rgba(15, 23, 42, 0.12)", transition: "transform 150ms, box-shadow 150ms", "&:hover": { transform: "translateY(-1px)" }, "&.Mui-disabled": { opacity: 0.75 } }}
            />
            <ButtonBase onClick={() => document.getElementById("learn-more")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" })} data-testid="home-discover" sx={{ ...FOOT_PILL, gap: 0.5, pl: { xs: 2, xl: 2.75 }, pr: { xs: 1.25, xl: 1.75 }, color: theme.palette.common.white, border: "1px solid rgba(255,255,255,0.4)", backgroundColor: "rgba(255,255,255,0.06)", transition: "background-color 200ms, border-color 200ms", "&:hover": { backgroundColor: "rgba(255,255,255,0.14)", borderColor: "rgba(255,255,255,0.7)" } }}>
              {t("home.discover")}
              <ExpandMoreIcon sx={{ fontSize: 20, ...(reduced ? {} : { animation: `${nudge} 1.8s ease-in-out infinite` }) }} />
            </ButtonBase>
          </Box>
        </Box>
      </HomeHero>
      </Box>
      {/* The presentation, edge to edge, on the page's blue (its parts draw no ground of their own): outside the
          column above, which is a plane of its own over the network. */}
      <Box id="learn-more" component="section" aria-label={t("home.more")} data-testid="landing-more" sx={{ position: "relative", flexShrink: 0, scrollMarginTop: 72 }}>
        <LearnMore onTryDemo={onLoadSample} ink />
      </Box>
    </Box>
  );
}
