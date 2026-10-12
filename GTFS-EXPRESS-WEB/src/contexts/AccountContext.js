/**
 * AccountContext — the signed-in user and their licence.
 *
 * Reading a feed is free and needs no account. Signing in is a six-digit
 * code sent by e-mail (2026-10-08: no password; the first code creates the
 * account). Under the paid offer every modification needs the licence
 * (`me.licence`: a subscription, a quote the operator granted with its end,
 * the free trial, or the operator's own address); the server's access
 * object (featuresApi.paidLockOf) says what stands in the way.
 *
 * Everything sits behind `features.accounts.enabled` (ACCOUNTS_ENABLED on
 * the API): while it is off the provider is inert — `enabled` is false and
 * the header shows nothing new.
 *
 * The Studio gates the ASSISTANT, never the journey (target design D30):
 * `requireStudio(open)` always opens (steps 2 and 3 can be done by hand) and
 * RETURNS the assistant's state — `{ opened, locked, reason, action }` — which
 * the caller renders in place with LockedAction (a disabled button, its
 * reason and the action that lifts it). It no longer shows a snackbar: a
 * lock is said before the click, next to the button, and stays until it is
 * lifted. The lock comes from the server's `access.studio`
 * (featuresApi.studioLockOf), never from adding entitlements up here.
 *
 *   enabled, loaded            — the flag, and whether the first look is done
 *   me                         — { id, email, email_verified, display_name, entitlements, licence, subscription } | null
 *                                (entitlements: the licence's — every source that runs)
 *   signedIn, entitlements     — derived from `me`
 *   licence                    — me.licence: { active, source, until, unlimited, trial_available, trial_until } | null
 *   hasEntitlement(name)       — "edit" | "studio"
 *   studioLocked               — accounts on and no "studio" entitlement
 *   studioLock                 — { reason, action } for LockedAction, or null (the assistant is served)
 *   requireStudio(open)        — opens; returns { opened: true, locked, reason?, action? }
 *   requestCode(email)         — a sign-in code sent to the address (in the reader's language)
 *   verifyCode(email, code)    — signed in: → { user, created }
 *   updateName(name)           — the name the account's acts are signed with
 *   startTrial(profile)        — the free trial of the licence started, with who tries it → the account
 *   signOut({ everywhere }) / refresh — signed out here, or on every device of the account
 *   deleteAccount(confirm)     — the account deleted (« Mes données »): its projects cached in this
 *                                browser forgotten (its own and the ones shared with it, unsaved writes
 *                                included: none may come back as this browser's), the recovery copies
 *                                cleared, then signed out
 *   openAccountDialog({ tab }) / closeAccountDialog
 *
 * `useAccount()` outside a provider returns the inert value, so components
 * that only read it (Header, the paywall, the palette) render in tests
 * without one.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as accountApi from "../utils/accountApi";
import { startTrial as startTrialApi } from "../utils/billingApi";
import { fetchFeatures, refreshFeatures, studioLockOf, useFeatures } from "../utils/featuresApi";
import { setIncludeCredentials } from "../utils/sessionManager";
import { forgetAccountProjects } from "../utils/projectStore";
import { clearSnapshots } from "../utils/projectAutoSave";
import { useLanguage } from "./LanguageContext";
import AccountDialog from "../components/account/AccountDialog";
import BillingReturn from "../components/billing/BillingReturn";

export const ACCOUNT_CHANGED_EVENT = "gtfs:account-changed";

const AccountContext = createContext(null);

const noop = async () => null;
const INERT = Object.freeze({
  enabled: false,
  loaded: true,
  me: null,
  signedIn: false,
  entitlements: [],
  hasEntitlement: () => false,
  studioLocked: false,
  studioLock: null,
  requireStudio: (open) => {
    if (typeof open === "function") open();
    return { opened: true, locked: false };
  },
  licence: null,
  requestCode: noop,
  verifyCode: noop,
  updateName: noop,
  startTrial: noop,
  signOut: noop,
  deleteAccount: noop,
  refresh: noop,
  openAccountDialog: () => {},
  closeAccountDialog: () => {},
});

const entitlementsOf = (user) => (user && Array.isArray(user.entitlements) ? user.entitlements : []);

export function AccountProvider({ children }) {
  const { t, language } = useLanguage();
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [me, setMe] = useState(null);
  const [dialog, setDialog] = useState(null); // null | { tab } (the tab is kept for the callers: one form signs in and up)
  const { features } = useFeatures();
  const meRef = useRef(me);
  meRef.current = me;

  const announce = useCallback((user) => {
    setMe(user);
    window.dispatchEvent(new CustomEvent(ACCOUNT_CHANGED_EVENT, { detail: { signedIn: Boolean(user) } }));
    // The access object names the caller: ask the server again (a sign-in may lift the assistant's lock).
    refreshFeatures().catch(() => null);
  }, []);

  // One look at boot: the flag, then the session cookie's owner.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const features = await fetchFeatures();
        const on = Boolean(features?.accounts?.enabled);
        if (cancelled) return;
        setEnabled(on);
        setIncludeCredentials(on);
        if (on) {
          const user = await accountApi.fetchMe().catch(() => null);
          if (!cancelled) setMe(user);
          // The first look at the access object may have left before the cookie rode along (credentials are turned on
          // just above): asked again for the account it names, or the paid offer would say "sign in" to a signed-in person.
          if (user && !cancelled) refreshFeatures().catch(() => null);
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return null;
    const user = await accountApi.fetchMe().catch(() => meRef.current);
    setMe(user);
    return user;
  }, [enabled]);

  const requestCode = useCallback((email) => accountApi.requestCode(email, language), [language]);

  const verifyCode = useCallback(
    async (email, code) => {
      const out = await accountApi.verifyCode(email, code);
      announce(out.user);
      return out;
    },
    [announce],
  );

  const updateName = useCallback(async (name) => {
    const user = await accountApi.updateMe({ display_name: name });
    setMe(user);
    return user;
  }, []);

  // The free trial of the licence: the account as the server now says it, and the locks asked again.
  const startTrial = useCallback(async (profile) => {
    const user = await startTrialApi(profile, language);
    announce(user);
    return user;
  }, [announce, language]);

  const signOut = useCallback(async (options) => {
    try {
      await accountApi.logout(options);
    } finally {
      announce(null);
    }
    return null;
  }, [announce]);


  // « Mes données »: the account deleted on the server, then nobody is signed in here either.
  const deleteAccount = useCallback(
    async (confirm) => {
      const out = await accountApi.deleteMyAccount(confirm);
      // Before signing out (which reads the works again): nothing of the account is pushed back from here.
      forgetAccountProjects();
      clearSnapshots().catch(() => null);
      announce(null);
      return out;
    },
    [announce],
  );

  const entitlements = useMemo(() => entitlementsOf(me), [me]);
  const hasEntitlement = useCallback((name) => entitlements.includes(name), [entitlements]);
  const studioLocked = enabled && !entitlements.includes("studio");

  const openAccountDialog = useCallback((opts = {}) => setDialog({ tab: opts.tab || "signin" }), []);
  const closeAccountDialog = useCallback(() => setDialog(null), []);

  // The assistant's lock, from the server's access object: the reason and
  // the one action that lifts it (sign in when nobody is, request an access,
  // see the plans) — rendered by LockedAction where the assistant is offered.
  const signedIn = Boolean(me);
  const studioLock = useMemo(
    () => studioLockOf(features?.access, t, { signIn: enabled && !signedIn ? () => setDialog({ tab: "signin" }) : null, requestUrl: features?.access?.request_access_url || features?.request_access_url || null }),
    [features, t, enabled, signedIn],
  );

  // The studio entry points always open (the journey is possible by hand);
  // what the assistant can do there is returned, never announced in a snackbar.
  const requireStudio = useCallback(
    (open) => {
      if (typeof open === "function") open();
      return studioLock ? { opened: true, locked: true, ...studioLock } : { opened: true, locked: false };
    },
    [studioLock],
  );

  const value = useMemo(
    () => ({
      enabled,
      loaded,
      me,
      signedIn: Boolean(me),
      entitlements,
      hasEntitlement,
      studioLocked,
      studioLock,
      requireStudio,
      licence: me?.licence || null,
      requestCode,
      verifyCode,
      updateName,
      startTrial,
      signOut,
      deleteAccount,
      refresh,
      openAccountDialog,
      closeAccountDialog,
    }),
    [enabled, loaded, me, entitlements, hasEntitlement, studioLocked, studioLock, requireStudio, requestCode, verifyCode, updateName, startTrial, signOut, deleteAccount, refresh, openAccountDialog, closeAccountDialog],
  );

  return (
    <AccountContext.Provider value={value}>
      {children}
      {enabled && <AccountDialog open={Boolean(dialog)} onClose={closeAccountDialog} />}
      {enabled && <BillingReturn />}
    </AccountContext.Provider>
  );
}

export function useAccount() {
  return useContext(AccountContext) || INERT;
}

export default AccountContext;
