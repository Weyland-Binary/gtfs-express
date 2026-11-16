// The links open in a new tab so that reading them never loses an address typed or an offer chosen.

import React from "react";
import { Box, Link } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { legalPath } from "../../utils/routes";

export default function LegalLinks({ tabs, sx = {}, testid = "legal-links" }) {
  const { t } = useLanguage();
  return (
    <Box data-testid={testid} sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 0.75, fontSize: "0.72rem", color: "text.secondary", ...sx }}>
      {tabs.map((tab, i) => (
        <React.Fragment key={tab}>
          {i > 0 && (
            <Box component="span" aria-hidden>
              ·
            </Box>
          )}
          <Link href={legalPath(tab)} target="_blank" rel="noopener" data-testid={`${testid}-${tab}`} sx={{ color: "inherit", textDecorationColor: "currentColor", "&:hover": { color: "text.primary" } }}>
            {t(`legal.tab.${tab}`)}
          </Link>
        </React.Fragment>
      ))}
    </Box>
  );
}
