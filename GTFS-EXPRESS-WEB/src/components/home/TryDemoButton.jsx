// The demo replaces the network open here, so unsaved edits go through the destructive guard first.

import React, { useState } from "react";
import { Box, ButtonBase, CircularProgress, Tooltip } from "@mui/material";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDestructiveGuard } from "../../contexts/DestructiveGuardContext";
import { useOpeningBusy } from "../../utils/networkOpening";

export default function TryDemoButton({ onTryDemo, sx }) {
  const { t } = useLanguage();
  const { guard } = useDestructiveGuard();
  const [loading, setLoading] = useState(false);
  // Another network opening on Home's screen holds the demo back until it is in the reader.
  const blocked = useOpeningBusy() && !loading;
  const tryDemo = () => {
    if (!onTryDemo || loading || blocked) return;
    guard(
      async () => {
        setLoading(true);
        try {
          await onTryDemo();
        } finally {
          setLoading(false);
        }
      },
      { reason: "loadSample" },
    );
  };
  return (
    <Tooltip title={blocked ? t("home.opening.busy") : ""} disableInteractive>
      <Box component="span" sx={{ display: "inline-flex" }}>
        <ButtonBase onClick={tryDemo} disabled={loading || blocked} data-testid="uploader-load-sample" sx={sx}>
          <VisibilityOutlinedIcon sx={{ fontSize: 20 }} />
          {t("uploader.trySample")}
          {loading ? <CircularProgress size={16} color="inherit" /> : <ArrowForwardRoundedIcon sx={{ fontSize: 19 }} />}
        </ButtonBase>
      </Box>
    </Tooltip>
  );
}
