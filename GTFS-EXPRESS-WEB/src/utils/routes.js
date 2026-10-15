/**
 * routes — the app's URLs, and a small history router to follow them.
 *
 * Every screen has its URL: a refresh, a new tab, the browser's back button
 * and a link sent to a colleague must all land where the person was.
 * react-router-dom is not a dependency of this web, so this module is a
 * minimal router on the History API that exposes the surface of its v6 the
 * app uses — `RouterProvider`, `useLocation`, `useNavigate`, `matchPath` —
 * so that moving to react-router would be a change of import, not of screens.
 *
 * The slugs are French, fixed and never localised: they do not follow
 * the interface language, the testids and component names stay English.
 *
 *   /                       Home (the landing)
 *   /r/:id/:tab             the explorer of one network: apercu · horaires ·
 *                           traces (edit mode) · sql · comparer · validation
 *   /r/:id                  → /r/:id/apercu
 *   /creer                  a new project that designs a network → /p/:id/1
 *   /modifier[?network=:id] a new project that modifies a network → /p/:id/1,
 *                           or /p/:id/3 when the explorer hands over the
 *                           network open in this tab (the network is chosen)
 *   /p/:id                  → the project's current step
 *   /p/:id/:step[/:tab]     the five steps (1 … 5, or their French aliases
 *                           reseau · contrat · conception | changement ·
 *                           controles · livraison, redirected to the number)
 *                           and the tab of the step's right pane (carte ·
 *                           lignes · arrets · detail · operations ·
 *                           changements · validateur)
 *   /p/:id/voir/:tab        the explorer inside the project (the explorer's
 *                           tabs; /p/:id/voir → /p/:id/voir/apercu)
 *   /partage/:token         the landing of a public share
 *   /accessibilite          the accessibility statement (RGAA: owed by the
 *                           public bodies that use the tool, reachable from
 *                           every screen's legal line)
 *   /conditions/:tab        the legal pages, one tab each: mentions-legales ·
 *                           utilisation (terms of use) · licence (terms of
 *                           sale) · confidentialite (privacy);
 *                           /conditions → /conditions/utilisation
 *   /regles                 the validation rules, searchable
 *   /admin[/:section[/:id]] the operator's console (English only, outside the app's i18n)
 *   anything else           → /
 *
 * Old links that may still be in someone's hands keep working:
 * `?share=` → /partage/:token (a share lives 90 days, and older share links
 * are `/?share=`), `#admin` → /admin, `#cgu` → the terms of use (the legal
 * line's old link), `?sql=1` → the SQL tab of the network open in this
 * browser tab (or / without one). A `?tab=` is ignored like any unknown
 * parameter.
 *
 * `:id` is not the server session: the session id is a bearer credential
 * (sessionStorage, sent as a header) and must never travel in a link. The
 * network id is a short random handle minted when a network is opened in
 * this browser tab and kept next to the session id; a URL whose handle is
 * not the one of this tab says the network is not open here.
 */

import React, { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";

export const APP_NAME = "GTFS Express";

// ── The route table ────────────────────────────────────────────────────────

/** The explorer's tabs, in the order of the network toolbar (validation is reached from the status bar). */
export const EXPLORER_TABS = Object.freeze(["apercu", "horaires", "traces", "sql", "comparer", "validation"]);
export const DEFAULT_EXPLORER_TAB = "apercu";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The five steps' French aliases (fixed, never localised), and the number each one stands for. */
export const STEP_SLUGS = Object.freeze({ reseau: 1, contrat: 2, conception: 3, changement: 3, controles: 4, livraison: 5 });
/** The tabs of a step's right pane, as URL slugs. */
export const STEP_TABS = Object.freeze(["carte", "lignes", "arrets", "detail", "operations", "changements", "validateur"]);
export const CREATE_PATH = "/creer";
export const MODIFY_PATH = "/modifier";
const stepOf = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
};
/** The URL of a project's step (and its tab); without a step, the project's own address (its current step). */
export const projectPath = (id, step = null, tab = null) => {
  const base = `/p/${encodeURIComponent(id)}`;
  const n = stepOf(step);
  if (!n) return base;
  return `${base}/${n}${tab && STEP_TABS.includes(tab) ? `/${tab}` : ""}`;
};
/** The explorer inside a project. */
export const projectExplorerPath = (id, tab = DEFAULT_EXPLORER_TAB) => `/p/${encodeURIComponent(id)}/voir/${EXPLORER_TABS.includes(tab) ? tab : DEFAULT_EXPLORER_TAB}`;
/** "Modify a network": the new project's address, with the network the explorer hands over. */
export const modifyPath = (networkId = null) => (networkId && ID_RE.test(networkId) ? `${MODIFY_PATH}?network=${encodeURIComponent(networkId)}` : MODIFY_PATH);
const SHARE_TOKEN_RE = /^[a-f0-9]{20}$/;

/** The explorer URL of a network and one of its tabs. */
export const explorerPath = (networkId, tab = DEFAULT_EXPLORER_TAB) => `/r/${encodeURIComponent(networkId)}/${EXPLORER_TABS.includes(tab) ? tab : DEFAULT_EXPLORER_TAB}`;
/** The landing URL of a public share. */
export const sharePath = (token) => `/partage/${encodeURIComponent(token)}`;
export const HOME_PATH = "/";
export const ADMIN_PATH = "/admin";
/** The console's sections, as their URLs name them (the first is the overview, at /admin itself). */
export const ADMIN_SECTIONS = Object.freeze(["overview", "accounts", "revenue", "usage", "activity", "operations"]);
/** A console URL: its section, then one object of it (an account's id). */
export const adminPath = (section = "overview", id = null) =>
  section === "overview" || !ADMIN_SECTIONS.includes(section) ? ADMIN_PATH : `${ADMIN_PATH}/${section}${id ? `/${encodeURIComponent(id)}` : ""}`;
export const ACCESSIBILITY_PATH = "/accessibilite";
/** The legal pages' tabs, in their order: the notice, the terms of use, the licence's terms of sale, privacy. */
export const LEGAL_TABS = Object.freeze(["mentions-legales", "utilisation", "licence", "confidentialite"]);
export const DEFAULT_LEGAL_TAB = "utilisation";
/** The URL of one legal page. */
export const legalPath = (tab = DEFAULT_LEGAL_TAB) => `/conditions/${LEGAL_TABS.includes(tab) ? tab : DEFAULT_LEGAL_TAB}`;
export const RULES_PATH = "/regles";

/**
 * react-router's `matchPath` for the patterns this app uses: literal
 * segments, `:param` segments and a trailing `*` (the rest, as `params["*"]`).
 * Returns `{ params }` or null.
 */
export function matchPath(pattern, pathname) {
  const want = String(pattern).split("/").filter(Boolean);
  const have = String(pathname || "/").split("/").filter(Boolean);
  const params = {};
  for (let i = 0; i < want.length; i++) {
    const part = want[i];
    if (part === "*") {
      params["*"] = have.slice(i).map(safeDecode).join("/");
      return { params };
    }
    if (i >= have.length) return null;
    if (part.startsWith(":")) params[part.slice(1)] = safeDecode(have[i]);
    else if (part !== have[i]) return null;
  }
  return have.length === want.length ? { params } : null;
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** A project's routes (/p/…): `{ name, params }` or `{ redirect }`, else null when the path is not one. */
function resolveProjectRoute(path) {
  const any = matchPath("/p/*", path);
  if (!any) return null;
  const [id, second, third, ...rest] = any.params["*"].split("/");
  if (!id || !ID_RE.test(id)) return { redirect: HOME_PATH };
  if (second === undefined) return { name: "project", params: { id, step: null, tab: null } };
  if (second === "voir") {
    if (third !== undefined && EXPLORER_TABS.includes(third) && !rest.length) return { name: "projectExplorer", params: { id, tab: third } };
    return { redirect: projectExplorerPath(id) };
  }
  const n = stepOf(second) || STEP_SLUGS[second] || null;
  if (!n || rest.length) return { redirect: projectPath(id) };
  const tab = third !== undefined && STEP_TABS.includes(third) ? third : null;
  // An alias, or a tab this router does not know: the canonical form replaces it.
  if (String(n) !== second || (third !== undefined && !tab)) return { redirect: projectPath(id, n, tab) };
  return { name: "project", params: { id, step: n, tab } };
}

/**
 * The screen a pathname shows: `{ name, params }`, or `{ redirect }` when the
 * URL is a short or unknown form of another one (the caller replaces it).
 * Names: home · explorer · share · admin ({ section?, id? }) · accessibility · legal ({ tab }) · rules · create ·
 * modify · project ({ id, step: 1…5 | null, tab }) · projectExplorer ({ id, tab }).
 */
export function resolveRoute(pathname) {
  const path = String(pathname || "/").replace(/\/+$/, "") || "/";
  if (path === "/") return { name: "home", params: {} };
  if (path === ADMIN_PATH) return { name: "admin", params: {} };
  const admin = matchPath("/admin/*", path);
  if (admin) {
    const [section, id, ...rest] = admin.params["*"].split("/");
    if (!ADMIN_SECTIONS.includes(section) || section === "overview" || rest.length) return { redirect: ADMIN_PATH };
    return { name: "admin", params: id ? { section, id } : { section } };
  }
  if (path === ACCESSIBILITY_PATH) return { name: "accessibility", params: {} };
  if (path === RULES_PATH) return { name: "rules", params: {} };
  if (path === "/conditions") return { redirect: legalPath() };
  const legal = matchPath("/conditions/:tab", path);
  if (legal) return LEGAL_TABS.includes(legal.params.tab) ? { name: "legal", params: legal.params } : { redirect: legalPath() };
  if (path === CREATE_PATH) return { name: "create", params: {} };
  if (path === MODIFY_PATH) return { name: "modify", params: {} };
  const project = resolveProjectRoute(path);
  if (project) return project;
  const share = matchPath("/partage/:token", path);
  if (share) return ID_RE.test(share.params.token) ? { name: "share", params: share.params } : { redirect: HOME_PATH };
  const bare = matchPath("/r/:id", path);
  if (bare) return ID_RE.test(bare.params.id) ? { redirect: explorerPath(bare.params.id) } : { redirect: HOME_PATH };
  const explorer = matchPath("/r/:id/*", path);
  if (explorer && ID_RE.test(explorer.params.id)) {
    const tab = explorer.params["*"];
    if (EXPLORER_TABS.includes(tab)) return { name: "explorer", params: { id: explorer.params.id, tab } };
    return { redirect: explorerPath(explorer.params.id) };
  }
  return { redirect: HOME_PATH };
}

/**
 * The URL an old link stands for, or null when `href` needs no rewrite.
 * `networkId` is the network open in this browser tab (a `?sql=1` link means
 * "the SQL tab of the network I have open"). Pure, so it is tested as is.
 */
export function legacyRedirect(href, { networkId = null } = {}) {
  let url;
  try {
    url = new URL(href, "http://localhost");
  } catch {
    return null;
  }
  const params = url.searchParams;
  const keep = (target, drop = []) => {
    const next = new URLSearchParams(params);
    for (const name of drop) next.delete(name);
    const query = next.toString();
    return `${target}${query ? `?${query}` : ""}`;
  };
  if (url.hash === "#admin") return keep(ADMIN_PATH);
  if (url.hash === "#cgu") return keep(legalPath("utilisation"));
  if (params.has("share")) {
    const token = params.get("share");
    return SHARE_TOKEN_RE.test(token || "") ? keep(sharePath(token), ["share", "tab", "sql"]) : keep(url.pathname, ["share"]) + url.hash;
  }
  if (url.pathname !== "/" || params.get("sql") !== "1") return null;
  return networkId && ID_RE.test(networkId) ? keep(explorerPath(networkId, "sql"), ["sql"]) : keep(HOME_PATH, ["sql"]);
}

// ── The network handle of this browser tab ─────────────────────────────────

const NETWORK_KEY = "gtfs_network_id";

/** The handle of the network open in this browser tab, or null. */
export const getNetworkId = () => {
  try {
    return sessionStorage.getItem(NETWORK_KEY);
  } catch {
    return null;
  }
};

/** Mint (and keep) a new handle: a network was opened in this tab. */
export const newNetworkId = () => {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  try {
    sessionStorage.setItem(NETWORK_KEY, id);
  } catch {
    /* storage disabled: the handle lives as long as the page */
  }
  return id;
};

// ── History ────────────────────────────────────────────────────────────────

/**
 * A history on `window.history`: the snapshot is the href string (stable
 * between changes, as useSyncExternalStore wants), `push`/`replace` write the
 * History API and tell the subscribers, `popstate` does too. Other code may
 * still write the query (the detail panel's `?panel=`); the next render
 * reads it, and the route never depends on it.
 */
export function createHistory(win = typeof window !== "undefined" ? window : null) {
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn());
  const write = (method, to, state) => {
    if (!win) return;
    const url = new URL(String(to), win.location.href);
    const next = `${url.pathname}${url.search}${url.hash}`;
    const current = `${win.location.pathname}${win.location.search}${win.location.hash}`;
    if (method === "pushState" && next === current) return;
    win.history[method](state ?? {}, "", next);
    notify();
  };
  return {
    getSnapshot: () => (win ? win.location.href : "/"),
    subscribe(fn) {
      listeners.add(fn);
      if (listeners.size === 1 && win) win.addEventListener("popstate", notify);
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0 && win) win.removeEventListener("popstate", notify);
      };
    },
    push: (to, state) => write("pushState", to, state),
    replace: (to, state) => write("replaceState", to, state),
    back: () => win?.history.back(),
  };
}

/** The app's history (one per page). */
export const history = createHistory();

/** Parse an href into react-router's location shape. */
export const locationOf = (href) => {
  const url = new URL(href, "http://localhost");
  return { pathname: url.pathname, search: url.search, hash: url.hash };
};

// ── React ──────────────────────────────────────────────────────────────────

const RouterContext = createContext(history);

/** Provides the history to `useLocation` / `useNavigate` (a test passes its own). */
export function RouterProvider({ history: own = history, children }) {
  return <RouterContext.Provider value={own}>{children}</RouterContext.Provider>;
}

/** The current location, `{ pathname, search, hash }`; re-renders on every navigation. */
export function useLocation() {
  const h = useContext(RouterContext);
  const href = useSyncExternalStore(h.subscribe, h.getSnapshot, h.getSnapshot);
  return useMemo(() => locationOf(href), [href]);
}

/** react-router's `navigate(to, { replace, state })`; `navigate(-1)` goes back. */
export function useNavigate() {
  const h = useContext(RouterContext);
  return useCallback(
    (to, { replace = false, state } = {}) => {
      if (to === -1) return h.back();
      return replace ? h.replace(to, state) : h.push(to, state);
    },
    [h],
  );
}

/** The resolved route of the current location (see `resolveRoute`). */
export function useRoute() {
  const { pathname } = useLocation();
  return useMemo(() => resolveRoute(pathname), [pathname]);
}

/** A document title: the screen, then its object, then the product. */
export const documentTitle = (...parts) => [...parts.filter(Boolean), APP_NAME].join(" — ");
