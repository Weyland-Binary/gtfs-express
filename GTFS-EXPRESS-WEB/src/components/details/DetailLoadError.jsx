import React from "react";
import { Alert, Button } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { humanError } from "../../utils/humanError";

/** A detail that could not be read (a 5xx, a 429, the network): never told as an entity that is gone. */
export default function DetailLoadError({ error, onRetry }) {
  const { t } = useLanguage();
  return (
    <Alert
      severity="error"
      data-testid="detail-load-error"
      action={
        <Button color="inherit" size="small" onClick={onRetry} data-testid="detail-load-retry">
          {t("error.human.retry")}
        </Button>
      }
    >
      {humanError(error, t)?.message || t("error.human.unknown")}
    </Alert>
  );
}
