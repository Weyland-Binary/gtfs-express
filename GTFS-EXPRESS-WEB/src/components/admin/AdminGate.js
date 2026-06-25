/**
 * AdminGate — token entry screen, shown until a valid ADMIN_TOKEN is
 * stored in localStorage and accepted by /admin/ping.
 *
 * Visual style mirrors the GTFS Explorer landing: same gradient hero
 * background, same brand chip, soft elevated card, decorative blurred
 * circles. The error case (503 ADMIN_TOKEN unset) is surfaced verbatim
 * so the operator can self-diagnose without server logs.
 */

import React, { useState } from "react";
import {
  Box,
  Paper,
  TextField,
  Button,
  Typography,
  Alert,
  CircularProgress,
  Stack,
  InputAdornment,
  IconButton,
  Chip,
  alpha,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { keyframes } from "@mui/system";
import VpnKeyIcon from "@mui/icons-material/VpnKey";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import LoginIcon from "@mui/icons-material/Login";
import { ping, setAdminToken } from "./adminApi";

const fadeUp = keyframes`
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
`;

function AdminGate({ onAuthenticated, initialError }) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const [token, setToken] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(initialError || "");

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setErr("");
    try {
      await ping(token.trim());
      setAdminToken(token.trim());
      onAuthenticated();
    } catch (e2) {
      if (e2.status === 401) setErr("Invalid token.");
      else if (e2.status === 503)
        setErr("Admin dashboard disabled. Set ADMIN_TOKEN in the API env.");
      else setErr(e2.message || "Could not validate token.");
      setBusy(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        overflow: "hidden",
        background: isDark
          ? "linear-gradient(135deg, #0d2137 0%, #1a365d 50%, #0d2137 100%)"
          : "linear-gradient(135deg, #1e3a5f 0%, #1976d2 50%, #1565c0 100%)",
        p: 3,
      }}
    >
      {/* Decorative circles, same recipe as the landing hero */}
      <Box
        sx={{
          position: "absolute",
          width: 520,
          height: 520,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(255,255,255,0.06) 0%, transparent 70%)",
          top: -200,
          right: -120,
          pointerEvents: "none",
        }}
      />
      <Box
        sx={{
          position: "absolute",
          width: 360,
          height: 360,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(255,255,255,0.04) 0%, transparent 70%)",
          bottom: -140,
          left: -80,
          pointerEvents: "none",
        }}
      />

      <Paper
        elevation={0}
        sx={{
          p: { xs: 3.5, md: 4.5 },
          width: "100%",
          maxWidth: 440,
          borderRadius: 3,
          background: theme.palette.background.paper,
          border: `1px solid ${theme.palette.divider}`,
          boxShadow: isDark
            ? "0 30px 60px rgba(0,0,0,0.5)"
            : "0 30px 60px rgba(15,23,42,0.18)",
          position: "relative",
          zIndex: 1,
          animation: `${fadeUp} 0.5s ease-out`,
        }}
      >
        <Stack alignItems="center" spacing={1.5} sx={{ mb: 3 }}>
          <Box
            sx={{
              width: 56,
              height: 56,
              borderRadius: 2.5,
              background: `linear-gradient(135deg, ${theme.palette.primary.main}, ${theme.palette.primary.dark})`,
              color: theme.palette.primary.contrastText,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: `0 8px 24px ${alpha(theme.palette.primary.main, 0.35)}`,
            }}
          >
            <VpnKeyIcon />
          </Box>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="h5" fontWeight={800} letterSpacing="-0.01em">
              GTFS Express
            </Typography>
            <Chip
              label="ADMIN"
              size="small"
              sx={{
                height: 20,
                fontSize: "0.62rem",
                fontWeight: 800,
                letterSpacing: "0.08em",
                background: alpha(theme.palette.primary.main, 0.12),
                color: theme.palette.primary.main,
              }}
            />
          </Stack>
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              textAlign: "center",
              maxWidth: 320,
              lineHeight: 1.55,
              fontSize: "0.85rem",
            }}
          >
            Enter the ADMIN_TOKEN configured on the API to open the operational
            telemetry dashboard.
          </Typography>
        </Stack>

        <Box component="form" onSubmit={handleSubmit}>
          <TextField
            autoFocus
            fullWidth
            label="Admin token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type={show ? "text" : "password"}
            disabled={busy}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    size="small"
                    onClick={() => setShow((s) => !s)}
                    tabIndex={-1}
                    aria-label={show ? "Hide token" : "Show token"}
                  >
                    {show ? <VisibilityOffIcon /> : <VisibilityIcon />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
            sx={{
              mb: 2,
              "& .MuiOutlinedInput-root": {
                borderRadius: 2,
              },
            }}
          />
          {err && (
            <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }}>
              {err}
            </Alert>
          )}
          <Button
            type="submit"
            fullWidth
            size="large"
            variant="contained"
            disabled={!token.trim() || busy}
            startIcon={
              busy ? (
                <CircularProgress size={18} sx={{ color: "inherit" }} />
              ) : (
                <LoginIcon fontSize="small" />
              )
            }
            sx={{
              py: 1.25,
              borderRadius: 2,
              fontWeight: 700,
              letterSpacing: "0.01em",
              textTransform: "none",
              fontSize: "0.95rem",
              boxShadow: `0 6px 18px ${alpha(theme.palette.primary.main, 0.35)}`,
              "&:hover": {
                boxShadow: `0 10px 24px ${alpha(theme.palette.primary.main, 0.45)}`,
              },
            }}
          >
            {busy ? "Verifying…" : "Sign in"}
          </Button>
        </Box>

        <Typography
          variant="caption"
          sx={{
            display: "block",
            mt: 3,
            textAlign: "center",
            color: "text.secondary",
            fontSize: "0.72rem",
            lineHeight: 1.5,
          }}
        >
          Token is stored in your browser's localStorage. Append{" "}
          <Box
            component="code"
            sx={{
              fontFamily: "monospace",
              background: alpha(theme.palette.primary.main, 0.08),
              color: theme.palette.primary.main,
              px: 0.6,
              py: 0.1,
              borderRadius: 0.5,
              fontSize: "0.7rem",
            }}
          >
            ?logout
          </Box>{" "}
          to the URL to clear it.
        </Typography>
      </Paper>
    </Box>
  );
}

export default AdminGate;
