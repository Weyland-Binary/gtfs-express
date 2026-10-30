/**
 * The app's URLs and a minimal History API router exposing the subset of react-router v6 the app uses,
 * so moving to react-router would change imports, not screens. Slugs are French and never localised.
 * `:id` is a random per-tab network handle, never the session id: that is a bearer credential and must
 * never travel in a link.
 */

import React, { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";

export const APP_NAME = "GTFS Express";

/** In the network toolbar's order. */
export const EXPLORER_TABS = Object.freeze(["apercu", "horaires", "fiches", "traces", "sql", "comparer", "validation"]);
export const DEFAULT_EXPLORER_TAB = "apercu";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Step aliases, redirected to their number. */
export const STEP_SLUGS = Object.freeze({ reseau: 1, changement: 3, livraison: 5 });
export const MODIFY_PATH = "/modifier";
const stepOf = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
};
/** Without a step, the project's own address, which opens its current step. */
export const projectPath = (id, step = null) => {
  const base = `/p/${encodeURIComponent(id)}`;
  const n = stepOf(step);
  return n ? `${base}/${n}` : base;
};
export const projectExplorerPath = (id, tab = DEFAULT_EXPLORER_TAB) => `/p/${encodeURIComponent(id)}/voir/${EXPLORER_TABS.includes(tab) ? tab : DEFAULT_EXPLORER_TAB}`;
export const modifyPath = (networkId = null) => (networkId && ID_RE.test(networkId) ? `${MODIFY_PATH}?network=${encodeURIComponent(networkId)}` : MODIFY_PATH);
const SHARE_TOKEN_RE = /^[a-f0-9]{20}$/;

export const explorerPath = (networkId, tab = DEFAULT_EXPLORER_TAB) => `/r/${encodeURIComponent(networkId)}/${EXPLORER_TABS.includes(tab) ? tab : DEFAULT_EXPLORER_TAB}`;
export const sharePath = (token) => `/partage/${encodeURIComponent(token)}`;
export const HOME_PATH = "/";
export const ADMIN_PATH = "/admin";
/** The overview lives at /admin itself. */
export const ADMIN_SECTIONS = Object.freeze(["overview", "funnel", "accounts", "revenue", "usage", "activity", "operations"]);
export const adminPath = (section = "overview", id = null) =>
  section === "overview" || !ADMIN_SECTIONS.includes(section) ? ADMIN_PATH : `${ADMIN_PATH}/${section}${id ? `/${encodeURIComponent(id)}` : ""}`;
export const ACCESSIBILITY_PATH = "/accessibilite";
export const LEGAL_TABS = Object.freeze(["mentions-legales", "utilisation", "licence", "confidentialite"]);
export const DEFAULT_LEGAL_TAB = "utilisation";
export const legalPath = (tab = DEFAULT_LEGAL_TAB) => `/conditions/${LEGAL_TABS.includes(tab) ? tab : DEFAULT_LEGAL_TAB}`;
export const RULES_PATH = "/regles";

/** Literal segments, `:param` segments and a trailing `*` (the rest, as `params["*"]`). */
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

/** `{ name, params }` or `{ redirect }`, else null when the path is not under /p/. */
function resolveProjectRoute(path) {
  const any = matchPath("/p/*", path);
  if (!any) return null;
  const [id, second, third, ...rest] = any.params["*"].split("/");
  if (!id || !ID_RE.test(id)) return { redirect: HOME_PATH };
  if (second === undefined) return { name: "project", params: { id, step: null } };
  if (second === "voir") {
    if (third !== undefined && EXPLORER_TABS.includes(third) && !rest.length) return { name: "projectExplorer", params: { id, tab: third } };
    return { redirect: projectExplorerPath(id) };
  }
  const n = stepOf(second) || STEP_SLUGS[second] || null;
  if (!n || rest.length) return { redirect: projectPath(id) };
  if (String(n) !== second || third !== undefined) return { redirect: projectPath(id, n) };
  return { name: "project", params: { id, step: n } };
}

// Each language's Home has its own address for search engines (vite.seo.js writes those pages).
export const LANGUAGE_HOME = /^\/(fr|en|es|de|pt|zh|hi)$/;

/** `{ name, params }`, or `{ redirect }` for a short or unknown form (the caller replaces the URL). */
export function resolveRoute(pathname) {
  const path = String(pathname || "/").replace(/\/+$/, "") || "/";
  if (path === "/" || LANGUAGE_HOME.test(path)) return { name: "home", params: {} };
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
 * Old links still in people's hands (`?share=`, `#admin`, `#cgu`, `?sql=1`) → their current URL, or null.
 * `?sql=1` means the SQL tab of the network open in this tab (`networkId`).
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

// ── The network handle of this browser tab

const NETWORK_KEY = "gtfs_network_id";

export const getNetworkId = () => {
  try {
    return sessionStorage.getItem(NETWORK_KEY);
  } catch {
    return null;
  }
};

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

// ── History

/**
 * The snapshot is the href string, stable between changes as useSyncExternalStore requires. Other code may
 * write the query (`?panel=`) directly; the route never depends on it.
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

export const history = createHistory();

export const locationOf = (href) => {
  const url = new URL(href, "http://localhost");
  return { pathname: url.pathname, search: url.search, hash: url.hash };
};

// ── React

const RouterContext = createContext(history);

export function RouterProvider({ history: own = history, children }) {
  return <RouterContext.Provider value={own}>{children}</RouterContext.Provider>;
}

export function useLocation() {
  const h = useContext(RouterContext);
  const href = useSyncExternalStore(h.subscribe, h.getSnapshot, h.getSnapshot);
  return useMemo(() => locationOf(href), [href]);
}

/** `navigate(to, { replace, state })`; `navigate(-1)` goes back. */
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

export function useRoute() {
  const { pathname } = useLocation();
  return useMemo(() => resolveRoute(pathname), [pathname]);
}

/** The screen, then its object, then the product. */
export const documentTitle = (...parts) => {
  const own = parts.filter(Boolean).join(" · ");
  return own ? `${own} | ${APP_NAME}` : APP_NAME;
};
