/**
 * LegalPage — the legal pages at /conditions/:tab: the legal notice, the terms of use, the licence's terms of sale
 * and the privacy policy, one tab each, one address each, so that the offer, the account dialog and an e-mail can
 * point at one.
 *
 * The texts (legalTexts.js) are in French, the version that prevails, and in English; a reader of another language
 * reads the English one and is told so, and anyone may switch between the two. Their figures and names come from
 * the server (`features.legal`): what the operator has not given of its legal notice is marked missing in place,
 * with a notice above, never a placeholder.
 *
 * Bare and readable: a heading, the date, the tabs, then the articles with their contents beside them on a wide
 * screen (a click scrolls to the article and puts the focus on its heading). Colours from the theme only (#19).
 */

import React, { useMemo, useRef, useState } from "react";
import { Alert, Box, ButtonBase, Link, Tab, Tabs, ToggleButton, ToggleButtonGroup, Typography, alpha, useMediaQuery, useTheme } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { useFeatures } from "../../utils/featuresApi";
import { LEGAL_TABS, legalPath, useNavigate } from "../../utils/routes";
import { formatYmd } from "../../utils/formatDate";
import { BASEMAP_PROVIDER } from "../map/basemapConfig";
import { OSRM_BASE } from "../../utils/osrmRouting";
import { LEGAL_UPDATED, legalDocuments } from "./legalTexts";

/** The host the browser asks for road routes (the privacy page names it). */
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/** An in-app link: a real href (a new tab, a copied link), followed in place on a plain click. */
function AppLink({ to, children, navigate }) {
  return (
    <Link
      href={to}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </Link>
  );
}

/** A string, or text and links in a row. */
function Parts({ parts, navigate }) {
  const list = Array.isArray(parts) ? parts : [parts];
  return list.map((part, i) => {
    if (typeof part === "string") return <React.Fragment key={i}>{part}</React.Fragment>;
    if (part?.to)
      return (
        <AppLink key={i} to={part.to} navigate={navigate}>
          {part.label}
        </AppLink>
      );
    if (part?.href) {
      const external = /^https:/i.test(part.href);
      return (
        <Link key={i} href={part.href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})} sx={{ overflowWrap: "anywhere" }}>
          {part.label}
        </Link>
      );
    }
    return null;
  });
}

const bodySx = { fontSize: "0.92rem", lineHeight: 1.7, color: "text.primary" };

/** One block of an article: a paragraph, a list, facts (label → value or « not given »), or a table. */
function Block({ block, missingLabel, navigate, narrow, sep }) {
  const theme = useTheme();
  if (block.p) {
    return (
      <Typography sx={bodySx}>
        <Parts parts={block.p} navigate={navigate} />
      </Typography>
    );
  }
  if (block.list) {
    return (
      <Box component="ul" sx={{ m: 0, pl: 2.5, display: "flex", flexDirection: "column", gap: 0.5, "& li": bodySx }}>
        {block.list.map((item, i) => (
          <li key={i}>
            <Parts parts={item} navigate={navigate} />
          </li>
        ))}
      </Box>
    );
  }
  if (block.facts) {
    return (
      <Box component="dl" sx={{ m: 0, display: "grid", gridTemplateColumns: { xs: "1fr", sm: "minmax(160px, 34%) 1fr" }, columnGap: 2, rowGap: { xs: 0.25, sm: 1 } }}>
        {block.facts.map(([label, value]) => (
          <React.Fragment key={label}>
            <Box component="dt" sx={{ fontSize: "0.82rem", fontWeight: 600, color: "text.secondary", pt: { xs: 0.75, sm: 0.2 } }}>
              {label}
            </Box>
            <Box component="dd" data-missing={value ? undefined : "true"} sx={{ m: 0, ...bodySx, ...(value ? {} : { color: "text.secondary", fontStyle: "italic" }) }}>
              {value ? <Parts parts={value} navigate={navigate} /> : missingLabel}
            </Box>
          </React.Fragment>
        ))}
      </Box>
    );
  }
  if (block.table) {
    const { head, rows } = block.table;
    // On a narrow screen each row is a card with its labels: no table wider than the page.
    if (narrow) {
      return (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {rows.map((row, i) => (
            <Box key={i} sx={{ border: `1px solid ${theme.palette.divider}`, borderRadius: 2, p: 1.5, display: "flex", flexDirection: "column", gap: 0.5 }}>
              <Typography sx={{ fontWeight: 700, fontSize: "0.9rem" }}>
                <Parts parts={row[0]} navigate={navigate} />
              </Typography>
              {row.slice(1).map((cell, j) => (
                <Typography key={j} sx={{ fontSize: "0.85rem", lineHeight: 1.55 }}>
                  <Box component="span" sx={{ color: "text.secondary", fontWeight: 600 }}>
                    {head[j + 1]}
                    {sep}
                  </Box>
                  <Parts parts={cell} navigate={navigate} />
                </Typography>
              ))}
            </Box>
          ))}
        </Box>
      );
    }
    return (
      <Box component="table" sx={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem", lineHeight: 1.55, "& th, & td": { textAlign: "left", verticalAlign: "top", p: "8px 10px", borderBottom: `1px solid ${theme.palette.divider}` }, "& th": { fontWeight: 700, color: "text.secondary", fontSize: "0.78rem", backgroundColor: alpha(theme.palette.text.primary, 0.04) }, "& td:first-of-type": { fontWeight: 600 } }}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>
                  <Parts parts={cell} navigate={navigate} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </Box>
    );
  }
  return null;
}

export default function LegalPage({ tab }) {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const { features } = useFeatures();
  const navigate = useNavigate();
  const wide = useMediaQuery(theme.breakpoints.up("md"));
  const narrow = useMediaQuery(theme.breakpoints.down("sm"));
  // The texts exist in French (authoritative) and English; every other language reads the English one.
  const [variant, setVariant] = useState(language === "fr" ? "fr" : "en");
  const headings = useRef({});
  const current = LEGAL_TABS.includes(tab) ? tab : LEGAL_TABS[1];

  const docs = useMemo(() => legalDocuments(variant, features?.legal, { tiles: BASEMAP_PROVIDER?.name, osrmHost: hostOf(OSRM_BASE) }), [variant, features?.legal]);
  const doc = docs[current];
  const missing = Array.isArray(features?.legal?.missing) ? features.legal.missing : [];
  const date = formatYmd(LEGAL_UPDATED.replace(/-/g, ""), language, "long");

  const goTo = (id) => {
    const el = headings.current[id];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.focus({ preventScroll: true });
  };

  return (
    <Box data-testid="legal-page" data-tab={current} data-variant={variant} lang={variant} sx={{ width: "100%", maxWidth: 1100, mx: "auto", px: { xs: 2, md: 3 }, py: { xs: 2, md: 3 }, display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ display: "flex", alignItems: { xs: "flex-start", sm: "flex-end" }, justifyContent: "space-between", gap: 2, flexWrap: "wrap" }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, minWidth: 0 }}>
          <Typography lang={language} sx={{ fontSize: "0.75rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "text.secondary" }}>
            {t("legal.kicker")}
          </Typography>
          <Typography component="h1" tabIndex={-1} data-testid="legal-title" sx={{ fontSize: { xs: "1.45rem", md: "1.75rem" }, fontWeight: 800, lineHeight: 1.2, outline: "none" }}>
            {doc.title}
          </Typography>
          <Typography lang={language} data-testid="legal-updated" sx={{ fontSize: "0.82rem", color: "text.secondary" }}>
            {t("legal.updated", { date })}
          </Typography>
        </Box>
        <ToggleButtonGroup size="small" exclusive value={variant} onChange={(_, v) => v && setVariant(v)} aria-label={t("legal.version")} data-testid="legal-variant">
          <ToggleButton value="fr" lang="fr" sx={{ px: 1.5, fontWeight: 700 }}>
            Français
          </ToggleButton>
          <ToggleButton value="en" lang="en" sx={{ px: 1.5, fontWeight: 700 }}>
            English
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box lang={language} sx={{ borderBottom: `1px solid ${theme.palette.divider}` }}>
        <Tabs value={current} variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile aria-label={t("legal.kicker")} data-testid="legal-tabs" sx={{ minHeight: 40, "& .MuiTab-root": { minHeight: 40, textTransform: "none", fontWeight: 600, fontSize: "0.88rem", px: 1.5 } }}>
          {LEGAL_TABS.map((key) => (
            <Tab
              key={key}
              value={key}
              label={t(`legal.tab.${key}`)}
              component="a"
              href={legalPath(key)}
              data-testid={`legal-tab-${key}`}
              onClick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                navigate(legalPath(key));
              }}
            />
          ))}
        </Tabs>
      </Box>

      {variant !== "fr" && (
        <Typography lang={language} data-testid="legal-authoritative" sx={{ fontSize: "0.82rem", color: "text.secondary" }}>
          {t("legal.authoritative")}
        </Typography>
      )}
      {current === "mentions-legales" && missing.length > 0 && (
        <Alert severity="warning" variant="outlined" data-testid="legal-missing" lang={language} sx={{ py: 0.25 }}>
          {t("legal.missing")}
        </Alert>
      )}
      {doc.intro && (
        <Typography data-testid="legal-intro" sx={{ ...bodySx, color: "text.secondary" }}>
          {doc.intro}
        </Typography>
      )}

      <Box sx={{ display: "grid", gridTemplateColumns: wide ? "220px minmax(0, 1fr)" : "minmax(0, 1fr)", gap: { md: 4 }, alignItems: "start" }}>
        {wide && (
          <Box component="nav" aria-label={t("legal.contents")} data-testid="legal-contents" sx={{ position: "sticky", top: 8, display: "flex", flexDirection: "column", gap: 0.25, borderLeft: `2px solid ${theme.palette.divider}`, pl: 1.25 }}>
            <Typography lang={language} sx={{ fontSize: "0.72rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "text.secondary", mb: 0.5 }}>
              {t("legal.contents")}
            </Typography>
            {doc.articles.map((a) => (
              <ButtonBase key={a.id} onClick={() => goTo(a.id)} sx={{ justifyContent: "flex-start", textAlign: "left", borderRadius: 1, px: 0.75, py: 0.4, fontSize: "0.8rem", lineHeight: 1.35, color: "text.secondary", "&:hover": { color: "text.primary", backgroundColor: alpha(theme.palette.text.primary, 0.05) }, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}` } }}>
                {a.title}
              </ButtonBase>
            ))}
          </Box>
        )}
        <Box data-testid="legal-articles" sx={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          {doc.articles.map((a) => (
            <Box key={a.id} component="section" aria-labelledby={`legal-${a.id}`} sx={{ display: "flex", flexDirection: "column", gap: 1, scrollMarginTop: 8 }}>
              <Typography component="h2" id={`legal-${a.id}`} tabIndex={-1} ref={(el) => (headings.current[a.id] = el)} sx={{ fontSize: "1.05rem", fontWeight: 800, outline: "none" }}>
                {a.title}
              </Typography>
              {a.blocks.map((block, i) => (
                <Block key={i} block={block} missingLabel={docs.missingLabel} navigate={navigate} narrow={narrow} sep={variant === "fr" ? "\u00a0: " : ": "} />
              ))}
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
