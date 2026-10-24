/**
 * The signed-in user (a six-digit code by e-mail, no password) and their licence. Inert while
 * `features.accounts.enabled` is off. Locks come from the server's access object (featuresApi), never
 * from entitlements added up here. `useAccount()` outside a provider returns the inert value.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as accountApi from "../utils/accountApi";
import { startTrial as startTrialApi } from "../utils/billingApi";
import { fetchFeatures, refreshFeatures, studioLockOf, useFeatures } from "../utils/featuresApi";
import { setIncludeCredentials } from "../utils/sessionManager";
import { trackUi } from "../utils/uiTelemetry";
import { forgetAccountProjects } from "../utils/projectStore";
import { useLanguage } from "./LanguageContext";
import AccountDialog from "../components/account/AccountDialog";
import BillingReturn from "../components/billing/BillingReturn";
import { ACCOUNT_CHANGED_EVENT } from "../utils/appEvents";


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
  const [dialog, setDialog] = useState(null); // null | { tab, reason }; one form signs in and up, so `tab` is only kept for the callers
  const { features } = useFeatures();
  const meRef = useRef(me);
  meRef.current = me;

  const announce = useCallback((user) => {
    setMe(user);
    window.dispatchEvent(new CustomEvent(ACCOUNT_CHANGED_EVENT, { detail: { signedIn: Boolean(user) } }));
    // The access object depends on the caller: a sign-in may lift a lock.
    refreshFeatures().catch(() => null);
  }, []);

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
          // The first features request may have left before credentials were turned on: ask again, or the paid
          // offer would say "sign in" to a signed-in person.
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


  const deleteAccount = useCallback(
    async (confirm) => {
      const out = await accountApi.deleteMyAccount(confirm);
      // Before signing out, so that none of the account's cached projects (unsaved writes included) is pushed back.
      forgetAccountProjects();
      announce(null);
      return out;
    },
    [announce],
  );

  const entitlements = useMemo(() => entitlementsOf(me), [me]);
  const hasEntitlement = useCallback((name) => entitlements.includes(name), [entitlements]);
  const studioLocked = enabled && !entitlements.includes("studio");

  // A sign-in asked is a funnel step for the operator's console.
  const openAccountDialog = useCallback(
    (opts = {}) => {
      if (!me) trackUi("signin.open", opts.from || (opts.reason && opts.reason.kind === "reader" ? "assistant" : "other"));
      setDialog({ tab: opts.tab || "signin", reason: opts.reason || null });
    },
    [me],
  );
  const closeAccountDialog = useCallback(() => setDialog(null), []);

  const signedIn = Boolean(me);
  const studioLock = useMemo(
    () => studioLockOf(features?.access, t, { signIn: enabled && !signedIn ? () => { trackUi("signin.open", "lock"); setDialog({ tab: "signin" }); } : null, requestUrl: features?.access?.request_access_url || features?.request_access_url || null }),
    [features, t, enabled, signedIn],
  );

  // Always opens (the work is possible by hand); the assistant's lock is returned for LockedAction to show
  // beside its button, never in a snackbar.
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
      {enabled && <AccountDialog open={Boolean(dialog)} onClose={closeAccountDialog} reason={dialog?.reason || null} />}
      {enabled && <BillingReturn />}
    </AccountContext.Provider>
  );
}

export function useAccount() {
  return useContext(AccountContext) || INERT;
}

export default AccountContext;
