/**
 * Where the community edition stops: the modification of a network and the printed documents belong to the hosted
 * edition of GTFS Express. Shown in a page's place (`variant="page"`) or in a dialog.
 */
import React from "react";
import { Box, Button, Dialog, DialogContent, Typography, alpha, useTheme } from "@mui/material";
import LockOpenOutlinedIcon from "@mui/icons-material/LockOpenOutlined";
import { useLanguage } from "../../contexts/LanguageContext";

export const HOSTED_URL = "https://gtfsexpress.com";

function Message({ onClose = null }) {
  const theme = useTheme();
  const { t } = useLanguage();
  return (
    <Box data-testid="hosted-only" sx={{ maxWidth: 460, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 1.5, p: 3 }}>
      <Box aria-hidden sx={{ width: 48, height: 48, borderRadius: "14px", display: "grid", placeItems: "center", bgcolor: alpha(theme.palette.primary.main, 0.12), color: "primary.main" }}>
        <LockOpenOutlinedIcon />
      </Box>
      <Typography component="h2" sx={{ fontSize: "1.15rem", fontWeight: 750 }}>
        {t("edition.hosted.title")}
      </Typography>
      <Typography color="text.secondary">{t("edition.hosted.body")}</Typography>
      <Box sx={{ display: "flex", gap: 1, mt: 1 }}>
        {onClose && (
          <Button color="inherit" onClick={onClose} sx={{ textTransform: "none" }}>
            {t("edition.hosted.close")}
          </Button>
        )}
        <Button variant="contained" disableElevation href={HOSTED_URL} target="_blank" rel="noopener" sx={{ textTransform: "none", fontWeight: 700 }}>
          {t("edition.hosted.open")}
        </Button>
      </Box>
    </Box>
  );
}

export default function HostedOnly({ variant = "page", open = true, onClose = null }) {
  if (variant === "dialog")
    return (
      <Dialog open={open} onClose={onClose || undefined} maxWidth="xs">
        <DialogContent sx={{ display: "flex", justifyContent: "center" }}>
          <Message onClose={onClose} />
        </DialogContent>
      </Dialog>
    );
  return (
    <Box sx={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Message onClose={onClose} />
    </Box>
  );
}
