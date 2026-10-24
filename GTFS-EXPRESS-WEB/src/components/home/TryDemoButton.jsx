// The demo replaces the network open here, so unsaved edits go through the destructive guard first.

import React, { useState } from "react";
import { ButtonBase, CircularProgress } from "@mui/material";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDestructiveGuard } from "../../contexts/DestructiveGuardContext";

export default function TryDemoButton({ onTryDemo, sx }) {
  const { t } = useLanguage();
  const { guard } = useDestructiveGuard();
  const [loading, setLoading] = useState(false);
  const tryDemo = () => {
    if (!onTryDemo || loading) return;
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
    <ButtonBase onClick={tryDemo} disabled={loading} data-testid="uploader-load-sample" sx={sx}>
      <VisibilityOutlinedIcon sx={{ fontSize: 20 }} />
      {t("uploader.trySample")}
      {loading ? <CircularProgress size={16} color="inherit" /> : <ArrowForwardRoundedIcon sx={{ fontSize: 19 }} />}
    </ButtonBase>
  );
}
