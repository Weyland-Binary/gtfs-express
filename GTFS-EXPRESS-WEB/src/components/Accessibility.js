/**
 * Accessibility — the accessibility statement, at /accessibilite (target
 * design §2.3, §11, WP9).
 *
 * The transport authorities that use GTFS Express are public bodies: the
 * tool falls under the RGAA and owes a statement, reachable from every
 * screen (the legal line under the status bar says « Accessibilité : non
 * conforme » and leads here). A statement is only worth what it says truly,
 * so this one says:
 *
 *   status     « non conforme » — no conformity audit has been carried out,
 *              and without one the RGAA asks for that mention; it is never
 *              « conforme » (the page has no words for it), and becomes
 *              « partiellement conforme » only with an audit's rate
 *   checks     what WAS checked, when and how: the automated axe-core run of
 *              the end-to-end tests (e2e/tests/a11y.spec.js, and the sign-in
 *              window in e2e/tests-projects/a11y-account.spec.js) — WCAG 2.1 A
 *              and AA rules, eighteen screens (Home with its presentation, the
 *              two journeys, the legal pages, the rules, the sign-in window and
 *              the offer), light and dark, no "serious" nor "critical"
 *              violation — and that it is not an
 *              audit (tools check a part of the criteria only); each screen
 *              is named as it was when scanned (the five steps of an empty
 *              project, the change step before any operation, the assistant
 *              off: the harness runs without it), never as more
 *   known      the non-conformities known today (the map, small screens, no
 *              reading with a screen reader yet) and every screen the scan
 *              does not reach, the ones of the two journeys included (modify
 *              ②, ④ and ⑤, the operation's dialog, the conversation with the
 *              assistant, the steps once filled), the share link's page and
 *              the rest of the account
 *   contact    the entity responsible for this server, and only it: the
 *              address the server gives (`request_access_url`, mailto or
 *              https — never an address written in the code, D39); when the
 *              operator gave none, the statement says so and points to the
 *              body that gave access, rather than to the upstream project,
 *              which does not run this server
 *   remedy     the Défenseur des droits, as the RGAA template words it
 *
 * `STATEMENT` holds the facts the text quotes (the date of the last checks,
 * the tool, the screens and their number); the e2e specs that run the checks
 * name the same screens. When the checks are run again, or an audit is made, the date
 * and the status change here, and nowhere else.
 */

import React from "react";
import { Box, Link, Typography } from "@mui/material";
import { useLanguage } from "../contexts/LanguageContext";
import { useFeatures, requestAccessLink } from "../utils/featuresApi";
import { formatYmd } from "../utils/formatDate";

/** The facts the statement quotes. `status`: "non_compliant" until an audit measures otherwise. */
export const STATEMENT = Object.freeze({
  status: "non_compliant",
  referential: "RGAA 4.1",
  // The last run of e2e/tests/a11y.spec.js (0 serious, 0 critical), and the day this statement was written.
  checkedAt: "2026-09-30",
  tool: "axe-core 4.13",
  // The groups of screens the runs check, and how many screens they are (home 1, create 5, modify 2, explorer 1,
  // legal 4, rules 1, the sign-in window's two steps and the offer 3, the statement 1).
  screens: Object.freeze(["home", "create", "modify", "explorer", "legal", "rules", "dialogs", "statement"]),
  screenCount: 18,
  known: Object.freeze(["map", "small", "screenReaders", "motion", "untested"]),
  remedy: Object.freeze({
    form: "https://formulaire.defenseurdesdroits.fr/",
    delegate: "https://www.defenseurdesdroits.fr/saisir/delegues",
  }),
});

/**
 * The status's words. Only an audit can make it « partiellement conforme »
 * (its rate of criteria met) — and there are no words here for « totalement
 * conforme »: any other status reads « non conforme ».
 */
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
  // The server's own contact, when it gives one (mailto: or https:, checked by requestAccessLink).
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
