/** The console's sign-in: the operator's account by a code sent by e-mail, or the admin token. English only. */

import React, { useState } from "react";
import { Alert, Box, Button, Link, Paper, Stack, TextField, Typography } from "@mui/material";
import { fetchMe, requestSignInCode, setAdminToken, verifySignInCode } from "./adminApi";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function AdminGate({ onSignedIn, initialError, accountsOn = true }) {
  const [way, setWay] = useState(accountsOn ? "account" : "token");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError || "");

  const enter = async (tokenUsed) => {
    try {
      const me = await fetchMe(tokenUsed);
      if (tokenUsed) setAdminToken(tokenUsed);
      onSignedIn(me);
    } catch (e) {
      if (e.status === 401 || e.status === 403) setError("Access denied.");
      else if (e.status === 503) setError("The console is off on this server.");
      else setError(e.message || "The console cannot be reached.");
    }
  };

  const sendCode = async (e) => {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) return setError("Type the operator's e-mail address.");
    setBusy(true);
    setError("");
    try {
      await requestSignInCode(email.trim());
      setSent(true);
    } catch (err) {
      if (err.status === 429) {
        // A code already sent a moment ago is still valid.
        setSent(true);
        setError("A code was sent a moment ago: type it below, or wait a minute for another one.");
      } else setError(err.status === 503 ? "No code can be sent from this server: use the admin token." : err.message || "The code could not be sent.");
    } finally {
      setBusy(false);
    }
  };

  const checkCode = async (e) => {
    e.preventDefault();
    const digits = code.replace(/\D/g, "");
    if (digits.length !== 6) return setError("The code has six digits.");
    setBusy(true);
    setError("");
    try {
      await verifySignInCode(email.trim(), digits);
      await enter("");
    } catch (err) {
      setError(err.code === "ADMIN_ACCESS_DENIED" ? "Access denied." : err.code === "LOGIN_CODE_INVALID" ? "This code is not the one sent." : err.code === "LOGIN_CODE_EXPIRED" ? "This code has expired: ask for a new one." : err.message || "The code could not be checked.");
    } finally {
      setBusy(false);
    }
  };

  const useToken = async (e) => {
    e.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setError("");
    await enter(token.trim());
    setBusy(false);
  };

  return (
    <Box lang="en" sx={{ minHeight: "100vh", display: "grid", placeItems: "center", bgcolor: "background.default", px: 2 }}>
      <Paper variant="outlined" sx={{ width: "100%", maxWidth: 400, borderRadius: "12px", p: 4 }} data-testid="admin-gate">
        <Stack direction="row" spacing={1.25} alignItems="center" sx={{ mb: 3 }}>
          <Box sx={{ width: 32, height: 32, borderRadius: "6px", bgcolor: "primary.main", color: "primary.contrastText", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 13 }}>GE</Box>
          <Box>
            <Typography sx={{ fontWeight: 700, fontSize: 15, lineHeight: 1.2 }}>GTFS Express</Typography>
            <Typography variant="caption" color="text.secondary">
              Operator console
            </Typography>
          </Box>
        </Stack>
        <Typography component="h1" sx={{ fontSize: 20, fontWeight: 650, mb: 0.5 }}>
          Sign in
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          {way === "account" ? (sent ? `A six-digit code was sent to ${email.trim()}.` : "With the operator's account: a code is sent by e-mail.") : "With the server's admin token."}
        </Typography>
        {error ? (
          <Alert severity="error" variant="outlined" sx={{ mb: 2, borderRadius: "8px" }} data-testid="admin-gate-error">
            {error}
          </Alert>
        ) : null}
        {way === "account" ? (
          sent ? (
            <form onSubmit={checkCode}>
              <TextField
                autoFocus
                fullWidth
                label="Code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputProps={{ inputMode: "numeric", autoComplete: "one-time-code", maxLength: 7, "data-testid": "admin-gate-code", style: { letterSpacing: "0.3em", fontSize: 18 } }}
              />
              <Button type="submit" fullWidth variant="contained" disableElevation disabled={busy} sx={{ mt: 2, py: 1.1 }} data-testid="admin-gate-verify">
                Sign in
              </Button>
              <Button fullWidth sx={{ mt: 1 }} onClick={() => { setSent(false); setCode(""); setError(""); }}>
                Use another address
              </Button>
            </form>
          ) : (
            <form onSubmit={sendCode}>
              <TextField autoFocus fullWidth type="email" label="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} inputProps={{ autoComplete: "email", "data-testid": "admin-gate-email" }} />
              <Button type="submit" fullWidth variant="contained" disableElevation disabled={busy} sx={{ mt: 2, py: 1.1 }} data-testid="admin-gate-send">
                Send a code
              </Button>
            </form>
          )
        ) : (
          <form onSubmit={useToken}>
            <TextField autoFocus fullWidth type="password" label="Admin token" value={token} onChange={(e) => setToken(e.target.value)} inputProps={{ autoComplete: "off", "data-testid": "admin-gate-token" }} />
            <Button type="submit" fullWidth variant="contained" disableElevation disabled={busy || !token.trim()} sx={{ mt: 2, py: 1.1 }} data-testid="admin-gate-token-submit">
              Sign in
            </Button>
          </form>
        )}
        {accountsOn ? (
          <Typography variant="body2" sx={{ mt: 3, textAlign: "center" }}>
            <Link
              component="button"
              type="button"
              underline="hover"
              onClick={() => {
                setWay(way === "account" ? "token" : "account");
                setError("");
              }}
              data-testid="admin-gate-switch"
            >
              {way === "account" ? "Use the admin token instead" : "Use the operator's account"}
            </Link>
          </Typography>
        ) : null}
      </Paper>
    </Box>
  );
}
