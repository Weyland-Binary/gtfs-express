/**
 * The frame every screen sits in: skip link, header, the project's rail and step actions (portal slots), <main> (the
 * only part that scrolls) with an aside beside it (`asideRef`: the assistant docks there), status bar and the legal
 * <nav> (no content outside a landmark, RGAA 12.6).
 * On a change of screen (`routeKey`) the focus moves to the screen's first heading, else to <main> (WCAG 2.4.3),
 * unless the person is working in a dialog, drawer or popover.
 */

import React, { cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, GlobalStyles, useTheme } from "@mui/material";
import { useLanguage } from "../contexts/LanguageContext";

const skipLinkSx = (theme) => ({
  position: "absolute",
  insetInlineStart: 8,
  top: -48,
  zIndex: theme.zIndex.tooltip + 1,
  px: 2,
  py: 1,
  borderRadius: 1,
  backgroundColor: theme.palette.primary.main,
  color: theme.palette.primary.contrastText,
  fontWeight: 700,
  textDecoration: "none",
  "&:focus": { top: 8, outline: `2px solid ${theme.palette.primary.contrastText}` },
});

/** The way past the header to <main id="main">; `onSkip` focuses the screen, else <main> itself takes the focus. */
export function SkipLink({ onSkip = null }) {
  const { t } = useLanguage();
  return (
    <Box
      component="a"
      href="#main"
      data-testid="skip-link"
      sx={skipLinkSx}
      onClick={(e) => {
        e.preventDefault();
        if (onSkip) onSkip();
        else document.getElementById("main")?.focus();
      }}
    >
      {t("a11y.skip")}
    </Box>
  );
}

const VISUALLY_HIDDEN_CSS = {
  ".visually-hidden": { position: "absolute !important", width: "1px !important", height: "1px !important", padding: "0 !important", margin: "-1px !important", overflow: "hidden !important", clip: "rect(0 0 0 0) !important", whiteSpace: "nowrap !important", border: "0 !important" },
};

/** Dialogs, drawers and popovers are portals outside the shell: a focus there is the person's, left alone. */
const focusIsBusyElsewhere = (active, shell) => {
  if (!active || active === document.body || active === document.documentElement) return false;
  if (!active.isConnected || !shell) return false;
  return !shell.contains(active);
};

const LATE_HEADING_MS = 3000;

export const focusScreen = (main) => {
  if (!main) return;
  const heading = main.querySelector("h1");
  const target = heading || main;
  if (heading && !heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  try {
    target.focus({ preventScroll: true });
  } catch {
    target.focus();
  }
};

const RailSlotContext = createContext(null);
const ActionsSlotContext = createContext(null);
// A mounted <Rail> registers itself: the header makes room only for a rail shown.
const RailUseContext = createContext(null);

/** Null where the header holds no actions slot: the step then keeps its own foot. */
export const useStepActionsSlot = () => useContext(ActionsSlotContext);

export function StepActions({ children }) {
  const slot = useContext(ActionsSlotContext);
  return slot ? createPortal(children, slot) : null;
}

/** `compact`: one control, sharing the header's row with the reader's tabs instead of a row of its own. */
export function Rail({ children, compact = false }) {
  const slot = useContext(RailSlotContext);
  const register = useContext(RailUseContext);
  // Before paint, so the header makes room in the same frame the rail appears.
  useLayoutEffect(() => (register ? register(compact ? "compact" : "full") : undefined), [register, compact]);
  return slot ? createPortal(children, slot) : null;
}

export default function AppShell({ header = null, statusBar = null, legal = null, title, routeKey, railSlot = false, railInHeader = false, flush = false, asideRef = null, children }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const shellRef = useRef(null);
  const mainRef = useRef(null);
  const firstRoute = useRef(true);
  const [slot, setSlot] = useState(null);
  const [actionsSlot, setActionsSlot] = useState(null);
  const [rails, setRails] = useState([]);
  const registerRail = useCallback((kind) => {
    const entry = { kind };
    setRails((list) => [...list, entry]);
    return () => setRails((list) => list.filter((x) => x !== entry));
  }, []);
  const railKind = rails.some((r) => r.kind === "full") ? "full" : rails.length ? "compact" : null;

  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    const active = document.activeElement;
    if (focusIsBusyElsewhere(active, shellRef.current)) return;
    let observer = null;
    let timer = null;
    const id = requestAnimationFrame(() => {
      const main = mainRef.current;
      focusScreen(main);
      // A lazy screen shows its heading after the frame: the focus moves there from <main> when it appears.
      if (!main || main.querySelector("h1") || typeof MutationObserver === "undefined") return;
      observer = new MutationObserver(() => {
        if (!main.querySelector("h1")) return;
        observer.disconnect();
        observer = null;
        clearTimeout(timer);
        if (document.activeElement === main) focusScreen(main);
      });
      observer.observe(main, { childList: true, subtree: true });
      timer = setTimeout(() => {
        if (observer) observer.disconnect();
        observer = null;
      }, LATE_HEADING_MS);
    });
    return () => {
      cancelAnimationFrame(id);
      if (observer) observer.disconnect();
      clearTimeout(timer);
    };
  }, [routeKey]);

  return (
    <Box ref={shellRef} sx={{ display: "flex", flexDirection: "column", height: "100dvh", minHeight: 0 }}>
      <GlobalStyles styles={VISUALLY_HIDDEN_CSS} />
      <SkipLink onSkip={() => focusScreen(mainRef.current)} />
      <Box sx={{ flexShrink: 0 }}>
        {railSlot && railInHeader && isValidElement(header) ? (
          cloneElement(header, { rail: railKind ? <div ref={setSlot} data-rail-slot="" /> : null, railCompact: railKind === "compact", actions: <div ref={setActionsSlot} data-actions-slot="" style={{ display: "contents" }} /> })
        ) : (
          <>
            {header}
            {railSlot ? <div ref={setSlot} data-rail-slot="" /> : <div data-testid="step-nav" data-state="empty" />}
          </>
        )}
      </Box>
      {/* scroll-padding-bottom: a control focused near the bottom is never left under a sticky footer (WCAG 2.4.11). */}
      <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
      <Box component="main" id="main" ref={mainRef} tabIndex={-1} sx={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflowY: "auto", overflowX: "hidden", px: flush ? 0 : 2, outline: "none", scrollPaddingBottom: "96px" }}>
        <RailUseContext.Provider value={railSlot ? registerRail : null}>
          <RailSlotContext.Provider value={railSlot ? slot : null}>
            <ActionsSlotContext.Provider value={railSlot && railInHeader ? actionsSlot : null}>{children}</ActionsSlotContext.Provider>
          </RailSlotContext.Provider>
        </RailUseContext.Provider>
      </Box>
      {asideRef && <Box ref={asideRef} data-testid="shell-aside" sx={{ flexShrink: 0, display: "flex", minHeight: 0, "&:empty": { display: "none" } }} />}
      </Box>
      <Box sx={{ flexShrink: 0, display: "flex", flexWrap: "wrap", alignItems: "stretch", background: theme.palette.mode === "dark" ? "#1e1e1e" : "#ffffff" }}>
        <Box sx={{ flex: "1 1 640px", minWidth: 0, display: "flex", flexDirection: "column", "& > footer": { flex: 1 } }}>{statusBar}</Box>
        {legal && (
          <Box component="nav" aria-label={t("a11y.legalNav")} data-testid="legal-nav" sx={{ flex: "0 1 auto", ml: "auto", display: "flex", alignItems: "center", borderTop: `1px solid ${theme.palette.divider}` }}>
            {legal}
          </Box>
        )}
      </Box>
    </Box>
  );
}
