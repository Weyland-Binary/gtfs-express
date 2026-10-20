/**
 * AppShell — the frame every screen sits in.
 *
 *   skip link  "Aller au contenu", the first focusable element (RGAA 12.7)
 *   header     the top bar and, in the explorer, the network's toolbar
 *              (the Header component; `main-header` is its <header>)
 *   step-nav   the rail of the steps inside a project (`railSlot`: the
 *              project's page puts its StepNav there through <Rail>, a
 *              portal, since the rail's states are the flow's); empty
 *              outside a project, where the explorer's tabs stand in its
 *              place, in the header's <nav aria-label="Réseau">. With
 *              `railInHeader` the slot is handed to the header (its `rail`
 *              prop), which puts it on its own row on a wide screen: one bar
 *              instead of two, the height goes to the work. The header gets a
 *              second slot too (`actions`): the Network Studio's bar holds
 *              the step's actions there (<StepActions>, from StepFrame)
 *   <main id="main">  the screen itself, the only part that scrolls (`flush`:
 *              edge to edge, the Network Studio's workbench sets its own
 *              margins)
 *   status bar the StatusBar (<footer>, "État du travail") and its separate
 *              `status-live` region
 *   legal      the terms, contact and accessibility line, at the end of the
 *              bar's row when both fit, else under it: a <nav aria-label=
 *              "Informations légales"> so that no content of the page sits
 *              outside a landmark (RGAA 12.6)
 *
 * Two things follow the route here so no screen has to: the document title
 * (`title`, set on every change of screen or language), and the focus — on
 * a change of screen (`routeKey`) made from the chrome (a tab, a status-bar
 * case, the brand) or that left the focus nowhere, the focus moves to the
 * screen's first heading, else to <main>, so a keyboard or screen-reader
 * user hears where they arrived (RGAA 12, WCAG 2.4.3). A change made while
 * the person is working elsewhere (a dialog, the assistant's drawer, a
 * field) leaves their focus alone.
 */

import React, { cloneElement, createContext, isValidElement, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, GlobalStyles, useTheme } from "@mui/material";
import { useLanguage } from "../contexts/LanguageContext";

// The skip link: hidden until it receives the focus, then on top of everything.
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

const VISUALLY_HIDDEN_CSS = {
  ".visually-hidden": { position: "absolute !important", width: "1px !important", height: "1px !important", padding: "0 !important", margin: "-1px !important", overflow: "hidden !important", clip: "rect(0 0 0 0) !important", whiteSpace: "nowrap !important", border: "0 !important" },
};

/**
 * Whether moving the focus to the new screen would take it from something
 * the person is using: a dialog, a drawer or a popover (portals, outside the
 * shell). Inside the shell — a tab, a status-bar case, a link of the old
 * screen — or nowhere at all, the focus follows the navigation.
 */
const focusIsBusyElsewhere = (active, shell) => {
  if (!active || active === document.body || active === document.documentElement) return false;
  if (!active.isConnected || !shell) return false;
  return !shell.contains(active);
};

// How long a screen loaded on demand may take to show its heading before the focus stays on <main>.
const LATE_HEADING_MS = 3000;

/** Put the focus on the screen's first heading (made focusable), else on <main>. */
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

// The element the rail is portaled into (null outside a project).
const RailSlotContext = createContext(null);
// The element the step's actions are portaled into (null where the header holds none).
const ActionsSlotContext = createContext(null);

/** The header's slot for the step's actions, or null (the step keeps its own foot). */
export const useStepActionsSlot = () => useContext(ActionsSlotContext);

/** The step's actions, rendered in the header's slot (nothing where there is none). */
export function StepActions({ children }) {
  const slot = useContext(ActionsSlotContext);
  return slot ? createPortal(children, slot) : null;
}

/** The project's rail, rendered in the shell's slot between the header and <main> (nothing outside a project). */
export function Rail({ children }) {
  const slot = useContext(RailSlotContext);
  return slot ? createPortal(children, slot) : null;
}

export default function AppShell({ header = null, statusBar = null, legal = null, title, routeKey, railSlot = false, railInHeader = false, flush = false, children }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const shellRef = useRef(null);
  const mainRef = useRef(null);
  const firstRoute = useRef(true);
  const [slot, setSlot] = useState(null);
  const [actionsSlot, setActionsSlot] = useState(null);

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
    // Let the new screen render its heading first.
    let observer = null;
    let timer = null;
    const id = requestAnimationFrame(() => {
      const main = mainRef.current;
      focusScreen(main);
      // A screen loaded on demand (React.lazy: the legal pages, the rules, a project) shows its heading a moment
      // later, after the frame: the focus, put on <main> meanwhile, moves to that heading when it appears, unless
      // the person moved it themselves in between.
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
      <Box component="a" href="#main" data-testid="skip-link" sx={skipLinkSx} onClick={(e) => {
        e.preventDefault();
        focusScreen(mainRef.current);
      }}>
        {t("a11y.skip")}
      </Box>
      <Box sx={{ flexShrink: 0 }}>
        {railSlot && railInHeader && isValidElement(header) ? (
          cloneElement(header, { rail: <div ref={setSlot} data-rail-slot="" />, actions: <div ref={setActionsSlot} data-actions-slot="" style={{ display: "contents" }} /> })
        ) : (
          <>
            {header}
            {railSlot ? <div ref={setSlot} data-rail-slot="" /> : <div data-testid="step-nav" data-state="empty" />}
          </>
        )}
      </Box>
      {/* scroll-padding-bottom: a control scrolled to or focused near the bottom is never left under the step's sticky
          footer (WCAG 2.4.11, focus not obscured) — the checks of ② sit at the end of a long contract. */}
      <Box component="main" id="main" ref={mainRef} tabIndex={-1} sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflowY: "auto", overflowX: "hidden", px: flush ? 0 : 2, outline: "none", scrollPaddingBottom: "96px" }}>
        <RailSlotContext.Provider value={railSlot ? slot : null}>
          <ActionsSlotContext.Provider value={railSlot && railInHeader ? actionsSlot : null}>{children}</ActionsSlotContext.Provider>
        </RailSlotContext.Provider>
      </Box>
      {/* The bar and the legal line share one row when both fit (a wide screen): the height goes to the work. */}
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
