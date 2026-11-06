/**
 * The accessibility statement (RGAA), at /accessibilite. It says only what is true: « non conforme » without an audit
 * (there are no words for « conforme »), what the automated axe-core runs of the e2e specs checked and that they are
 * not an audit, the known non-conformities and the screens the scan does not reach, the contact the server gives (never
 * an address written in the code), and the Défenseur des droits as remedy. When the checks are run again, or an audit
 * is made, the date and the status change in `STATEMENT` and nowhere else; the e2e specs name the same screens.
 */

import React from "react";
import { Box, Link, Typography } from "@mui/material";
import { useLanguage } from "../contexts/LanguageContext";
import { useFeatures, requestAccessLink } from "../utils/featuresApi";
import { formatYmd } from "../utils/formatDate";

/** `status`: "non_compliant" until an audit measures otherwise. */
export const STATEMENT = Object.freeze({
  status: "non_compliant",
  referential: "RGAA 4.1",
  // The last run of e2e/tests/a11y.spec.js (0 serious, 0 critical), and the day this statement was written.
  checkedAt: "2026-09-30",
  tool: "axe-core 4.13",
  // How many screens the runs check (home 1, modify 2, explorer 1, legal 4, rules 1, the sign-in window's two
  // steps and the offer 3, the statement 1).
  screens: Object.freeze(["home", "modify", "explorer", "legal", "rules", "dialogs", "statement"]),
  screenCount: 13,
  known: Object.freeze(["map", "small", "screenReaders", "untested"]),
  remedy: Object.freeze({
    form: "https://formulaire.defenseurdesdroits.fr/",
    delegate: "https://www.defenseurdesdroits.fr/saisir/delegues",
  }),
});

/** Only an audit's rate makes it « partiellement conforme »; any other status reads « non conforme ». */
export const statusKey = (status = STATEMENT.status) => (status === "partial" ? "accessibility.status.partial" : "accessibility.status.nonCompliant");

const sectionSx = { display: "flex", flexDirection: "column", gap: 0.75 };
const h2Sx = { fontSize: "1.05rem", fontWeight: 800, mt: 1 };
const pSx = { fontSize: "0.9rem", lineHeight: 1.6 };
const listSx = { m: 0, pl: 3, display: "flex", flexDirection: "column", gap: 0.5, "& li": { fontSize: "0.9rem", lineHeight: 1.6 } };

function Section({ id, title, children }) {
  return (
    <Box component="section" aria-labelledby={id} sx={sectionSx}>
      <Typography component="h2" id={id} sx={h2Sx}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

export default function Accessibility() {
  const { t, language } = useLanguage();
  const { features } = useFeatures();
  // A calendar day, the same in every time zone.
  const date = formatYmd(STATEMENT.checkedAt.replace(/-/g, ""), language, "long");
  // mailto: or https:, checked by requestAccessLink.
  const serverContact = requestAccessLink(features?.request_access_url, { subject: t("accessibility.contact.subject") });

  return (
    <Box data-testid="accessibility-statement" data-status={STATEMENT.status} sx={{ maxWidth: 820, width: "100%", mx: "auto", py: 3, display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        <Typography component="h1" tabIndex={-1} sx={{ fontSize: "1.5rem", fontWeight: 800, lineHeight: 1.25, outline: "none" }}>
          {t("accessibility.title")}
        </Typography>
        <Typography sx={pSx}>{t("accessibility.intro")}</Typography>
      </Box>

      <Section id="a11y-status" title={t("accessibility.status.title")}>
        <Typography data-testid="accessibility-status" sx={{ ...pSx, fontWeight: 800, fontSize: "1rem" }}>
          {t(statusKey())}
        </Typography>
        {STATEMENT.status === "non_compliant" && <Typography sx={pSx}>{t("accessibility.status.nonCompliant.body", { referential: STATEMENT.referential })}</Typography>}
      </Section>

      <Section id="a11y-checks" title={t("accessibility.checks.title")}>
        <Typography sx={pSx}>{t("accessibility.checks.body")}</Typography>
        <Box component="ul" sx={listSx}>
          <li data-testid="accessibility-checked-at">{t("accessibility.checks.date", { date })}</li>
          <li data-testid="accessibility-method">{t("accessibility.checks.method", { tool: STATEMENT.tool, count: STATEMENT.screenCount })}</li>
          <li>{t("accessibility.checks.result")}</li>
        </Box>
        <Typography sx={pSx}>{t("accessibility.checks.screens", { count: STATEMENT.screenCount })}</Typography>
        <Box component="ul" sx={listSx}>
          {STATEMENT.screens.map((screen) => (
            <li key={screen}>{t(`accessibility.screen.${screen}`)}</li>
          ))}
        </Box>
        <Typography sx={pSx}>{t("accessibility.checks.also")}</Typography>
      </Section>

      <Section id="a11y-known" title={t("accessibility.known.title")}>
        <Box component="ul" data-testid="accessibility-known" sx={listSx}>
          {STATEMENT.known.map((item) => (
            <li key={item}>{t(`accessibility.known.${item}`)}</li>
          ))}
        </Box>
        <Typography sx={pSx}>{t("accessibility.derogation")}</Typography>
      </Section>

      <Section id="a11y-tech" title={t("accessibility.tech.title")}>
        <Typography sx={pSx}>{t("accessibility.tech.body")}</Typography>
      </Section>

      <Section id="a11y-contact" title={t("accessibility.contact.title")}>
        <Typography sx={pSx}>{t("accessibility.contact.body")}</Typography>
        <Box component="ul" data-testid="accessibility-contact" sx={listSx}>
          {serverContact ? (
            <li>
              <Link href={serverContact} data-testid="accessibility-contact-server">
                {t("accessibility.contact.server")}
              </Link>
            </li>
          ) : (
            <li data-testid="accessibility-contact-none">{t("accessibility.contact.none")}</li>
          )}
        </Box>
      </Section>

      <Section id="a11y-remedy" title={t("accessibility.remedy.title")}>
        <Typography sx={pSx}>{t("accessibility.remedy.body")}</Typography>
        <Box component="ul" sx={listSx}>
          <li>
            <Link href={STATEMENT.remedy.form} target="_blank" rel="noopener noreferrer">
              {t("accessibility.remedy.form")}
            </Link>
          </li>
          <li>
            <Link href={STATEMENT.remedy.delegate} target="_blank" rel="noopener noreferrer">
              {t("accessibility.remedy.delegate")}
            </Link>
          </li>
          <li>{t("accessibility.remedy.mail")}</li>
        </Box>
      </Section>

      <Typography sx={{ ...pSx, color: "text.secondary" }}>{t("accessibility.established", { date })}</Typography>
    </Box>
  );
}
