/**
 * The offer: reading is free, the licence opens every modification. Prices are the server's (GET /config/plans),
 * never written here. Three ways to the licence: the trial, paying online, a quote; each but the quote wants an
 * account first, so the sign-in opens and the way asked goes on once signed in (ACCOUNT_CHANGED_EVENT).
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogContent, IconButton, Link, TextField, Typography, alpha, useTheme } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import CheckIcon from "@mui/icons-material/Check";
import MailOutlineIcon from "@mui/icons-material/MailOutline";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import WorkspacePremiumOutlinedIcon from "@mui/icons-material/WorkspacePremiumOutlined";
import HourglassEmptyOutlinedIcon from "@mui/icons-material/HourglassEmptyOutlined";
import CreditCardOutlinedIcon from "@mui/icons-material/CreditCardOutlined";
import RequestQuoteOutlinedIcon from "@mui/icons-material/RequestQuoteOutlined";
import AccountBalanceOutlinedIcon from "@mui/icons-material/AccountBalanceOutlined";
import API_BASE_URL from "../config";
import { useLanguage } from "../contexts/LanguageContext";
import { useAccount } from "../contexts/AccountContext";
import { requestAccessLink } from "../utils/featuresApi";
import { fetchWithSession } from "../utils/sessionManager";
import { trackUi } from "../utils/uiTelemetry";
import { openPortal, requestQuote, startCheckout } from "../utils/billingApi";
import { humanError } from "../utils/humanError";
import { launchOf, priceNoteOf } from "../utils/launchOffer";
import { licenceDateOf } from "./account/LicencePanel";
import LegalLinks from "./legal/LegalLinks";
import TrialForm from "./account/TrialForm";
import LaunchBadge from "./account/LaunchBadge";
import { ACCOUNT_CHANGED_EVENT } from "../utils/appEvents";


/** The account's cookie names the caller. */
export async function fetchPlans() {
  const res = await fetchWithSession(`${API_BASE_URL}/config/plans`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 4900 → « 4 900 € » in the reader's language. */
const euros = (value, language) => {
  try {
    return new Intl.NumberFormat(language || "fr", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${value} €`;
  }
};

function FeatureRow({ children }) {
  return (
    <Box sx={{ display: "flex", gap: 0.75, alignItems: "flex-start", fontSize: "0.8rem", lineHeight: 1.45 }}>
      <CheckIcon sx={{ fontSize: 15, mt: "2px", color: "success.main", flexShrink: 0 }} />
      <span>{children}</span>
    </Box>
  );
}

function Way({ testid, icon: Icon, title, body, children }) {
  const theme = useTheme();
  return (
    <Box data-testid={testid} sx={{ display: "flex", flexDirection: "column", gap: 0.75, p: 1.75, borderRadius: 2, border: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Icon sx={{ fontSize: 20, color: "primary.main" }} />
        <Typography sx={{ fontWeight: 800, fontSize: "0.9rem" }}>{title}</Typography>
      </Box>
      <Typography sx={{ fontSize: "0.78rem", color: "text.secondary", lineHeight: 1.5, flex: 1 }}>{body}</Typography>
      {children}
    </Box>
  );
}

function QuoteForm({ me, onCancel, onSent }) {
  const { t } = useLanguage();
  const [form, setForm] = useState({ organisation: "", name: me?.display_name || "", email: me?.email || "", phone: "", seats: 1, message: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const ready = form.organisation.trim() && form.name.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());

  const send = async (e) => {
    e?.preventDefault?.();
    if (!ready || busy) return;
    setError(null);
    setBusy(true);
    try {
      const seats = parseInt(form.seats, 10);
      await requestQuote({ organisation: form.organisation.trim(), name: form.name.trim(), email: form.email.trim(), phone: form.phone.trim() || undefined, seats: Number.isInteger(seats) && seats > 0 ? seats : undefined, message: form.message.trim() || undefined });
      onSent();
    } catch (err) {
      setError(humanError(err, t)?.message || t("error.human.unknown"));
      setBusy(false);
    }
  };

  const field = (key, props = {}) => <TextField size="small" fullWidth label={t(`licence.quote.${key}`)} value={form[key]} onChange={set(key)} disabled={busy} inputProps={{ "data-testid": `quote-${key}` }} {...props} />;
  return (
    <Box component="form" onSubmit={send} noValidate data-testid="licence-quote-form" sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 1.25 }}>
      <Typography sx={{ gridColumn: "1 / -1", fontSize: "0.82rem", color: "text.secondary", lineHeight: 1.5 }}>{t("licence.quote.intro")}</Typography>
      {field("organisation", { required: true, autoFocus: true, autoComplete: "organization" })}
      {field("name", { required: true, autoComplete: "name" })}
      {field("email", { required: true, type: "email", autoComplete: "email" })}
      {field("phone", { autoComplete: "tel" })}
      {field("seats", { type: "number", inputProps: { "data-testid": "quote-seats", min: 1, max: 9999 } })}
      <Box />
      {field("message", { multiline: true, minRows: 3, sx: { gridColumn: "1 / -1" } })}
      {error && (
        <Typography role="alert" data-testid="pricing-error" sx={{ gridColumn: "1 / -1", fontSize: "0.8rem", color: "error.main" }}>
          {error}
        </Typography>
      )}
      <Box sx={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: 1 }}>
        <Button onClick={onCancel} disabled={busy} data-testid="quote-cancel" sx={{ textTransform: "none", fontWeight: 600 }}>
          {t("licence.quote.back")}
        </Button>
        <Button type="submit" variant="contained" disableElevation disabled={!ready || busy} startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <MailOutlineIcon />} data-testid="quote-send" sx={{ textTransform: "none", fontWeight: 800 }}>
          {t("licence.quote.send")}
        </Button>
      </Box>
    </Box>
  );
}

const QUOTE_BUTTON = '[data-testid="licence-quote-open"], [data-testid="licence-quote-mail"]';

/** `way`: « quote » brings the quote's way into view, its button focused; « quote-form » opens its form. */
export default function PricingDialog({ open, onClose, reason = null, way = null }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const account = useAccount();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // "trial" | "online" | "portal"
  const [actionError, setActionError] = useState(null);
  const [quote, setQuote] = useState(null); // null | "form" | "sent"
  const [trialForm, setTrialForm] = useState(false);
  // A way asked without an account: the sign-in first, then that way goes on.
  const [pending, setPending] = useState(null);
  const waysRef = useRef(null);
  const wayShownRef = useRef(false);

  const load = useCallback(() => {
    setError(null);
    fetchPlans()
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!open) {
      wayShownRef.current = false;
      setActionError(null);
      setBusy(null);
      setPending(null);
      setQuote(null);
      setTrialForm(false);
      return undefined;
    }
    load();
    // A sign-in or a trial from inside the offer changes the licence: read it again.
    window.addEventListener(ACCOUNT_CHANGED_EVENT, load);
    return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, load);
  }, [open, load]);

  const paid = data?.model === "paid";
  const checkout = data?.checkout || "contact";
  const signedIn = account.signedIn;
  const licence = data?.licence || account.licence || null;
  const active = Boolean(licence?.active);
  // The free trial runs: everything can be tried, the ways to the licence stay offered (the work leaves with it).
  const trialOnly = active && licence?.source === "trial";
  const trialDays = Number(data?.trial_days) || 0;
  const pro = (data?.plans || []).find((p) => p.id === "pro") || null;

  const act = useCallback(
    async (way) => {
      setActionError(null);
      setBusy(way);
      try {
        if (way === "trial") {
          setTrialForm(true);
          setBusy(null);
        } else if (way === "online") await startCheckout("pro");
        else if (way === "online-month") await startCheckout("pro", { period: "month" });
        else if (way === "portal") await openPortal();
      } catch (err) {
        setActionError(humanError(err, t)?.message || t("error.human.unknown"));
        setBusy(null);
      }
    },
    [t],
  );

  /** A way that wants the account: signed in, it runs; else the sign-in opens and it waits. */
  const ask = (way) => {
    trackUi("offer.choice", way === "online" ? "year" : way === "online-month" ? "month" : way);
    if (account.enabled && !signedIn) {
      setPending(way);
      account.openAccountDialog({ tab: "signin", from: "offer" });
      return;
    }
    act(way);
  };

  // Signed in from inside the offer: the way asked goes on, unless the licence already runs.
  useEffect(() => {
    if (!open || !pending || !signedIn || !data) return;
    const way = pending;
    setPending(null);
    if (!data.licence?.active || (data.licence.source === "trial" && way !== "trial")) act(way);
  }, [open, pending, signedIn, data, act]);

  // Authorities and operators buy on a purchase order: the quote's way, brought into view with its button focused.
  const showQuote = useCallback(() => {
    const ways = waysRef.current;
    const button = ways && ways.querySelector(QUOTE_BUTTON);
    const target = button || (ways && ways.querySelector('[data-testid="licence-quote"]'));
    if (!target) return;
    const still = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
    if (button) button.focus({ preventScroll: true });
  }, []);
  // Opened for the quote: once the offer is read, its way or its form, once per opening.
  useEffect(() => {
    if (!open || !data || wayShownRef.current || (way !== "quote" && way !== "quote-form")) return;
    wayShownRef.current = true;
    if (way === "quote-form" && data.quote) setQuote("form");
    else showQuote();
  }, [open, data, way, showQuote]);

  const requestUrl = data?.request_access_url || (data?.contact_email ? `mailto:${data.contact_email}` : null);
  const mailto = requestAccessLink(requestUrl, { subject: "GTFS Express — licence", body: "Hello,\n\nI would like the GTFS Express licence.\n\nOrganisation:\nNumber of accounts:\n\nThank you." });
  const until = licenceDateOf(licence?.until, language);
  const title = paid && reason === "deliver" ? t("licence.dialog.deliver") : paid && (reason === "edit" || reason === "studio") ? t("licence.dialog.locked") : t("licence.dialog.title");
  const subtitle = data && !paid ? t("licence.dialog.open") : paid && reason === "deliver" ? t("licence.dialog.deliverSub") : t("licence.dialog.subtitle");

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="md" fullWidth PaperProps={{ sx: { borderRadius: 3 } }} data-testid="pricing-dialog" data-model={data?.model || undefined}>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.25, px: 3, pt: 2.5, pb: 1 }}>
        <Box sx={{ width: 36, height: 36, borderRadius: "10px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: theme.palette.primary.contrastText, background: theme.palette.primary.main }}>
          {paid && reason ? <LockOutlinedIcon sx={{ fontSize: 19 }} /> : <WorkspacePremiumOutlinedIcon sx={{ fontSize: 20 }} />}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography component="h2" sx={{ fontWeight: 800, fontSize: "1.15rem", lineHeight: 1.25 }}>
            {title}
          </Typography>
          <Typography sx={{ fontSize: "0.82rem", color: "text.secondary", lineHeight: 1.5, mt: 0.25 }}>{subtitle}</Typography>
        </Box>
        <IconButton size="small" onClick={onClose} disabled={Boolean(busy)} aria-label={t("app.close")}>
          <CloseIcon />
        </IconButton>
      </Box>
      <DialogContent sx={{ pt: 1.5 }}>
        {error && <Typography sx={{ color: "error.main", fontSize: "0.8rem" }}>{error}</Typography>}
        {!data && !error && (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress size={22} />
          </Box>
        )}
        {data && quote === "form" && <QuoteForm me={account.me} onCancel={() => setQuote(null)} onSent={() => setQuote("sent")} />}
        {data && trialForm && quote !== "form" && (
          <TrialForm
            days={trialDays}
            onCancel={() => setTrialForm(false)}
            onSubmit={async (profile) => {
              await account.startTrial(profile);
              setTrialForm(false);
              load();
            }}
          />
        )}
        {data && quote !== "form" && !trialForm && (
          <>
            <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "1fr 1.25fr" }, gap: 1.5 }}>
              {(data.plans || [])
                .filter((plan) => plan.id === "free" || plan.id === "pro")
                .map((plan) => {
                  const isLicence = plan.id === "pro";
                  const launch = launchOf(isLicence ? plan : null);
                  return (
                    <Box key={plan.id} data-testid={`plan-${plan.id}`} sx={{ borderRadius: 2.5, p: 2, border: `1px solid ${isLicence ? alpha(theme.palette.primary.main, 0.6) : theme.palette.divider}`, background: isLicence ? alpha(theme.palette.primary.main, 0.04) : "transparent", display: "flex", flexDirection: "column", gap: 1 }}>
                      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                        <Typography sx={{ fontWeight: 800, fontSize: "1rem", flex: 1 }}>{t(isLicence ? "licence.name" : "paywall.plan.free.name")}</Typography>
                        {isLicence && launch.offer && plan.price_eur > 0 && <LaunchBadge testId="plan-pro-launch" />}
                        {isLicence && active && <Chip size="small" label={t("licence.yours")} color="success" variant="outlined" sx={{ fontWeight: 700 }} data-testid="plan-pro-current" />}
                      </Box>
                      <Box sx={{ display: "flex", alignItems: "baseline", gap: 0.5, flexWrap: "wrap" }}>
                        <Typography sx={{ fontWeight: 900, fontSize: "1.6rem", lineHeight: 1 }} data-testid={`plan-${plan.id}-price`}>
                          {plan.price_eur > 0 ? euros(plan.price_eur, language) : t("pricing.free")}
                        </Typography>
                        {plan.price_eur > 0 && <Typography sx={{ fontSize: "0.76rem", color: "text.secondary" }}>{t("licence.perYear")}</Typography>}
                      </Box>
                      {isLicence && plan.price_eur_month > 0 && (
                        <Typography data-testid="plan-pro-monthly" sx={{ fontSize: "0.78rem", fontWeight: 600 }}>
                          {t("licence.perMonthAlt", { price: euros(plan.price_eur_month, language) })}
                        </Typography>
                      )}
                      {isLicence && plan.price_eur > 0 && <Typography data-testid="plan-pro-note" sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{priceNoteOf(t, launch, language)}</Typography>}
                      <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", lineHeight: 1.45 }}>{t(isLicence ? "licence.tagline" : "paywall.plan.free.tagline")}</Typography>
                      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, my: 0.5 }}>
                        {plan.features.map((f) => (
                          <FeatureRow key={f}>{t(`pricing.feature.${f}`, { count: plan.limits?.reader_questions_month ?? "" })}</FeatureRow>
                        ))}
                      </Box>
                    </Box>
                  );
                })}
            </Box>

            {paid && active && (
              <Box data-testid="licence-active" sx={{ mt: 1.75, display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap", p: 1.5, borderRadius: 2, background: alpha(theme.palette.success.main, 0.07) }}>
                <Typography sx={{ flex: 1, minWidth: 220, fontSize: "0.84rem" }}>{trialOnly ? t("licence.trialUntil", { date: until || "" }) : until ? t("licence.activeUntil", { date: until }) : t("licence.activeNoEnd")}</Typography>
                {licence.source === "subscription" && checkout === "stripe" && (
                  <Button variant="outlined" onClick={() => act("portal")} disabled={Boolean(busy)} data-testid="licence-manage" sx={{ textTransform: "none", fontWeight: 700 }}>
                    {t("billing.manage")}
                  </Button>
                )}
              </Box>
            )}

            {paid && (!active || trialOnly) && (
              <Box ref={waysRef} sx={{ mt: 2 }}>
                {(data.quote || mailto) && (
                  <Box data-testid="licence-public-buyers" sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", mb: 2, fontSize: "0.84rem" }}>
                    <AccountBalanceOutlinedIcon aria-hidden sx={{ fontSize: 18, color: "primary.main" }} />
                    <Typography component="span" sx={{ fontSize: "inherit" }}>
                      {t("licence.publicBuyers")}
                    </Typography>
                    <Link component="button" type="button" onClick={showQuote} underline="always" data-testid="licence-public-buyers-quote" sx={{ fontSize: "inherit", fontWeight: 700 }}>
                      {t("licence.way.quote.cta")}
                    </Link>
                  </Box>
                )}
                <Typography sx={{ fontSize: "0.72rem", fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "text.secondary", mb: 1 }}>{t("licence.ways")}</Typography>
                {quote === "sent" && (
                  <Alert severity="success" sx={{ mb: 1.25 }} data-testid="quote-sent">
                    {t("licence.quote.sent")}
                  </Alert>
                )}
                <Box data-testid="licence-ways" sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "repeat(3, 1fr)" }, gap: 1.25 }}>
                  {trialDays > 0 && !trialOnly && (
                    <Way testid="licence-trial" icon={HourglassEmptyOutlinedIcon} title={t("licence.way.trial.title", { days: trialDays })} body={signedIn && licence && !licence.trial_available ? t("licence.way.trial.used") : t("licence.way.trial.body")}>
                      <Button variant="contained" disableElevation onClick={() => ask("trial")} disabled={Boolean(busy) || (signedIn && Boolean(licence) && !licence.trial_available)} startIcon={busy === "trial" ? <CircularProgress size={14} color="inherit" /> : null} data-testid="licence-trial-start" sx={{ textTransform: "none", fontWeight: 800 }}>
                        {account.enabled && !signedIn ? t("licence.way.signInFirst") : t("licence.way.trial.cta")}
                      </Button>
                    </Way>
                  )}
                  <Way testid="licence-online" icon={CreditCardOutlinedIcon} title={t("licence.way.online.title")} body={checkout === "contact" ? t("licence.way.online.soon") : t("licence.way.online.body")}>
                    {checkout !== "contact" && pro && (
                      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                        <Button variant="outlined" onClick={() => ask("online")} disabled={Boolean(busy)} startIcon={busy === "online" ? <CircularProgress size={14} color="inherit" /> : null} data-testid="licence-online-pay" sx={{ textTransform: "none", fontWeight: 800 }}>
                          {busy === "online" ? t("billing.redirecting") : pro.monthly ? t("licence.way.online.year") : t("licence.way.online.cta")}
                        </Button>
                        {pro.monthly && (
                          <Button variant="outlined" onClick={() => ask("online-month")} disabled={Boolean(busy)} startIcon={busy === "online-month" ? <CircularProgress size={14} color="inherit" /> : null} data-testid="licence-online-pay-month" sx={{ textTransform: "none", fontWeight: 800 }}>
                            {busy === "online-month" ? t("billing.redirecting") : t("licence.way.online.month")}
                          </Button>
                        )}
                      </Box>
                    )}
                  </Way>
                  <Way testid="licence-quote" icon={RequestQuoteOutlinedIcon} title={t("licence.way.quote.title")} body={t("licence.way.quote.body")}>
                    {data.quote ? (
                      <Button
                        variant="outlined"
                        onClick={() => {
                          trackUi("offer.choice", "quote");
                          setQuote("form");
                        }}
                        disabled={Boolean(busy)}
                        data-testid="licence-quote-open" sx={{ textTransform: "none", fontWeight: 800 }}>
                        {t("licence.way.quote.cta")}
                      </Button>
                    ) : mailto ? (
                      <Button variant="outlined" startIcon={<MailOutlineIcon />} href={mailto} target="_blank" rel="noreferrer" onClick={() => trackUi("offer.choice", "quote_mail")} data-testid="licence-quote-mail" sx={{ textTransform: "none", fontWeight: 800 }}>
                        {t("licence.way.quote.cta")}
                      </Button>
                    ) : null}
                  </Way>
                </Box>
              </Box>
            )}
          </>
        )}
        {actionError && (
          <Typography role="alert" data-testid="pricing-error" sx={{ mt: 1.5, fontSize: "0.8rem", color: "error.main" }}>
            {actionError}
          </Typography>
        )}
        {data && quote !== "form" && (
          <Box sx={{ mt: 2, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
            {/* In a new tab, so the offer stays open. */}
            <LegalLinks tabs={["licence", "confidentialite"]} testid="pricing-legal" />
            <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{paid && checkout === "stripe" ? t("paywall.footnote.secure") : t("licence.footnote")}</Typography>
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}
