/**
 * Home, a light page in the theme's blue: its head (the title and the network finder, a town's published feeds or the
 * person's GTFS file dropped, each to explore for free or to modify behind the licence's gate, beside a network drawing
 * itself), the banners for projects this browser still owns, the strip of what is sure, the features, the showcase of
 * the real screens, then how it works, the guarantees, the prices, the questions and the call to open a network.
 */

import React, { useLayoutEffect, useRef, useState } from "react";
import { Alert, Box, Button, useTheme } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { useAccount } from "../../contexts/AccountContext";
import { importLegacyProjects, refreshProjects, retryLocalProjects, useLegacyProjects, useProjects } from "../../utils/projectStore";
import { attachWorkspaceToAccount } from "../../utils/projectApi";
import { licenceLockOf, useFeatures } from "../../utils/featuresApi";
import GTFSUploader from "../GTFSUploader";
import HomeHero, { HomeTitle } from "./HomeHero";
import HeroNetwork from "./HeroNetwork";
import { HomeFeatures, HomeStrip } from "./HomeFeatures";
import Showcase from "./Showcase";
import TryDemoButton from "./TryDemoButton";
import ScrollCue from "./ScrollCue";
import TrialButton from "./TrialButton";
import FindNetworkPanel from "../FindNetworkPanel";
import LearnMore from "./LearnMore";
import { countWords } from "../../utils/countWords";
import { homeGroundOf } from "./inkGround";
import { PICK_GTFS_FILE_EVENT, READ_GTFS_FILE_EVENT } from "../../utils/appEvents";

// The demo and the trial under the finder: two quiet pills.
const FOOT_PILL = { display: "inline-flex", alignItems: "center", gap: 0.75, height: 42, px: 2, borderRadius: 999, fontSize: "0.95rem", fontWeight: 650 };

/** The scrolling area Home sits in and its height: the first screen fills it, so the blue below starts at the fold. */
function useScrollArea(ref) {
  const [area, setArea] = useState({ scroller: null, height: null });
  useLayoutEffect(() => {
    let scroller = ref.current?.parentElement || null;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!scroller) return undefined;
    const measure = () => setArea({ scroller, height: scroller.clientHeight || null });
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [ref]);
  return area;
}

/** Projects kept only in this browser's localStorage, offered once to the server. */
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
      {countWords(t, "home.import.body", count)}
    </Alert>
  );
}

/**
 * Signed in with projects still owned by this browser: move them to the account (the token replaced). The ones the
 * browser's quota refused are then offered to the server again, an account having no such quota.
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
      {state === "failed" ? t("home.attach.failed", { count }) : countWords(t, "home.attach.body", count)}
    </Alert>
  );
}

export default function Home({ onUploadSuccess, onLoadSample, onModifyNetwork, onNetworkConsult = null, onNetworkFound = null, onNetworkFile = null, beforeModify = null, sampleError, sessionLost = false }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const { features } = useFeatures();
  const lock = licenceLockOf(features?.access);
  const modifyLocked = lock === "sign_in_required" || lock === "subscription_required";
  const projects = useProjects();
  const foldRef = useRef(null);
  const { scroller, height: fold } = useScrollArea(foldRef);
  const legacy = useLegacyProjects();
  const owned = projects.filter((p) => !p.owner?.user_id);

  return (
    <Box data-testid="home" sx={{ position: "relative", width: "100%", minHeight: "100%", alignSelf: "flex-start", display: "flex", flexDirection: "column", backgroundColor: homeGroundOf(theme) }}>
      <Box ref={foldRef} data-testid="home-fold" sx={{ display: "flex", flexDirection: "column", flexShrink: 0, minHeight: fold || "auto" }}>
      <HomeHero grow cue={<ScrollCue scroller={scroller} targetId="home-showcase" />}>
        {sessionLost && (
          <Alert
            severity="warning"
            data-testid="session-expired"
            action={
              <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
                <Button color="inherit" size="small" onClick={onModifyNetwork} sx={{ textTransform: "none", fontWeight: 700 }}>
                  {t("recovery.catalogue")}
                </Button>
                <Button color="inherit" size="small" onClick={() => window.dispatchEvent(new CustomEvent(PICK_GTFS_FILE_EVENT))} sx={{ textTransform: "none", fontWeight: 700 }}>
                  {t("recovery.upload")}
                </Button>
              </Box>
            }
          >
            <strong>{t("recovery.title")}</strong> · {t("recovery.notFound")}
          </Alert>
        )}
        <ImportBanner count={legacy.length} />
        <AttachBanner count={owned.length} />

        <Box data-testid="home-find">
          <FindNetworkPanel
            intent="home"
            heading={<HomeTitle />}
            aside={<HeroNetwork />}
            trust={
              <Box data-testid="home-actions" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1.5, mt: { xs: -1, md: -2 } }}>
                <TryDemoButton onTryDemo={() => onLoadSample?.()} sx={{ ...FOOT_PILL, color: "primary.main", border: `1px solid ${theme.palette.divider}`, backgroundColor: theme.palette.background.paper, "&:hover": { borderColor: theme.palette.primary.main }, "&.Mui-disabled": { opacity: 0.75 } }} />
                <TrialButton sx={{ ...FOOT_PILL, color: theme.palette.primary.contrastText, backgroundColor: theme.palette.primary.main, "&:hover": { backgroundColor: theme.palette.primary.dark } }} />
              </Box>
            }
            onConsult={(result) => onNetworkConsult?.(result)}
            onOpened={(result) => onNetworkFound?.(result)}
            beforeModify={beforeModify}
            modifyLocked={modifyLocked}
            // An explored file is read by the GTFSUploader below, which shows its phases, refusals and repair station.
            onExploreFile={(file) => window.dispatchEvent(new CustomEvent(READ_GTFS_FILE_EVENT, { detail: { file } }))}
            onModifyFile={(file) => onNetworkFile?.(file)}
            fileFoot={<GTFSUploader compact dropzone={false} onUploadSuccess={onUploadSuccess} onLoadSample={onLoadSample} sampleError={sampleError} />}
            autoFocus={false}
            labelledBy="home-title"
          />
        </Box>
      </HomeHero>
      <HomeStrip />
      </Box>
      <Box id="home-showcase">
        <Showcase onTry={(key) => onLoadSample?.({ show: key })} />
      </Box>
      <HomeFeatures />
      <Box id="learn-more" component="section" aria-label={t("home.more")} data-testid="landing-more" sx={{ position: "relative", flexShrink: 0, scrollMarginTop: 72 }}>
        <LearnMore onTryDemo={() => onLoadSample?.()} />
      </Box>
    </Box>
  );
}
