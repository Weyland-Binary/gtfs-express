/**
 * StepContract — ② Contrat: what the brief imposes, decided by a named
 * person BEFORE any design by the assistant (G4). The page frames the ContractPanel (common/ContractPanel: the
 * clauses must / should, « à vérifier à la main », the assumptions, the
 * requirement sentences without a clause (G5), Essentiel / Expert, the
 * extraction and the clauses written by hand) and carries the step's two
 * acts:
 *
 *   contract-proceed          the primary action (« Concevoir avec ce
 *                             contrat » / « Rédiger le plan avec ce
 *                             contrat »): active once every must clause is
 *                             decided and the decider named — or with no
 *                             clause at all: the contract is then recorded
 *                             empty (« 0 clause — contrat vide »), but
 *                             never over requirement sentences the detector
 *                             lists: closed with « N exigences sans clause »
 *                             until each is answered, or dismissed under a
 *                             name by « Enregistrer un contrat vide »
 *   contract-proceed-assumed  « … avec le contrat supposé »: the contract
 *                             taken as it is, under the person's name; the
 *                             delivery asks them to accept it by name
 *                             (ASSUMPTIONS_UNVALIDATED)
 *
 * The Network Studio owns the contract, the server calls
 * and the navigation: this page only lays them out.
 *
 * In the Network Studio the page is a StudioSheet: the contract's state in
 * four indicators (`contract-summary`: the clauses, the must clauses
 * decided, the requirement sentences without a clause, the contract's
 * state and who decided it), the ContractPanel as the work, and beside it
 * how the contract carries to the delivery (`contract-guide`).
 */

import React from "react";
import { Box, Button, Tooltip, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import ArticleOutlinedIcon from "@mui/icons-material/ArticleOutlined";
import HowToRegOutlinedIcon from "@mui/icons-material/HowToRegOutlined";
import StraightenOutlinedIcon from "@mui/icons-material/StraightenOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { isDecided } from "../../utils/contract";
import ContractPanel from "../common/ContractPanel";
import StudioSheet, { KpiTiles, SheetCard } from "../studio/StudioSheet";
import { tokensOf } from "../studio/studioTheme";
import { useStepActionsSlot } from "../AppShell";
import StepFrame, { useFillLayout } from "./StepFrame";

/** The contract's state in indicators, from the contract and the server's coverage (never guessed). */
export const contractTiles = (contract, coverage, t) => {
  const clauses = Array.isArray(contract?.clauses) ? contract.clauses : [];
  const must = clauses.filter((c) => c.level !== "should");
  const decided = must.filter(isDecided).length;
  const uncovered = Array.isArray(coverage?.uncovered) ? coverage.uncovered.length : null;
  const status = ["decided", "assumed", "empty"].includes(contract?.status) ? contract.status : "draft";
  return [
    { id: "clauses", label: t("contract.kpi.clauses"), value: String(clauses.length), tone: clauses.length ? "accent" : "neutral", hint: t("contract.kpi.clausesHint", { must: must.length, should: clauses.length - must.length }) },
    { id: "decided", label: t("contract.kpi.decided"), value: must.length ? `${decided} / ${must.length}` : "—", tone: !must.length ? "neutral" : decided === must.length ? "ok" : "warn", hint: t("contract.kpi.decidedHint") },
    uncovered == null ? null : { id: "uncovered", label: t("contract.kpi.uncovered"), value: String(uncovered), tone: uncovered ? "warn" : "ok", hint: t(uncovered ? "contract.kpi.uncoveredHint" : "contract.kpi.uncoveredNone") },
    { id: "state", label: t("contract.kpi.state"), value: t(`contract.kpi.state.${status}`), tone: status === "decided" ? "ok" : status === "draft" ? "neutral" : "warn", hint: contract?.decided_by ? t("contract.kpi.by", { name: contract.decided_by }) : t("contract.kpi.byNone") },
  ];
};

/** How the contract carries to the delivery: drawn from the brief, decided under a name, measured on the timetable. */
function ContractGuide({ extract = false }) {
  const { t } = useLanguage();
  const k = tokensOf(useTheme());
  const items = [
    { icon: ArticleOutlinedIcon, title: t("contract.guide.source.title"), body: t(extract ? "contract.guide.source.body" : "contract.guide.source.manual") },
    { icon: HowToRegOutlinedIcon, title: t("contract.guide.decide.title"), body: t("contract.guide.decide.body") },
    { icon: StraightenOutlinedIcon, title: t("contract.guide.measure.title"), body: t("contract.guide.measure.body") },
  ];
  return (
    <SheetCard title={t("contract.guide.title")} testid="contract-guide">
      <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 1.25 }}>
        {items.map(({ icon: Icon, title, body }) => (
          <Box component="li" key={title} sx={{ display: "flex", gap: 1.1, alignItems: "flex-start" }}>
            <Box sx={{ width: 28, height: 28, flexShrink: 0, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: k.accentSoft, color: k.accent }}>
              <Icon sx={{ fontSize: 16 }} />
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontSize: "0.82rem", fontWeight: 600, color: k.ink }}>{title}</Typography>
              <Typography sx={{ fontSize: "0.78rem", color: k.ink2, lineHeight: 1.5 }}>{body}</Typography>
            </Box>
          </Box>
        ))}
      </Box>
    </SheetCard>
  );
}

export default function StepContract({ contract, onChange = null, conformance = null, coverage = null, coverageState = null, extract = null, brief = "", onBrief = null, name = "", onName = null, readOnly = false, primary, assumed = null, back, footer = null, notice = null }) {
  const { t } = useLanguage();
  const fill = useFillLayout();
  const inBar = Boolean(useStepActionsSlot()) && fill;
  const intro = t(extract ? "contract.intro" : "contract.intro.manual.create");
  const assumedButton = assumed ? (
    <Tooltip title={t("contract.assumed.body")}>
      <span>
        <Button size="small" onClick={assumed.onClick} disabled={Boolean(assumed.disabled)} data-testid="contract-proceed-assumed" sx={{ textTransform: "none", fontWeight: 700 }}>
          {t("contract.assumed")}
        </Button>
      </span>
    </Tooltip>
  ) : null;
  return (
    // The assistant's part is said only where it takes part; without it, what the contract is for.
    <StepFrame step={2} job="create" intro={intro} notice={notice} primary={primary ? { ...primary, alias: "contract-proceed" } : null} back={back} footer={inBar ? footer : <>{footer}{assumedButton}</>} testid="step-contract" headless>
      <StudioSheet testid="contract-sheet" lead={inBar ? intro : null} tiles={<KpiTiles tiles={contractTiles(contract, coverage, t)} testid="contract-summary" />} aside={<ContractGuide extract={Boolean(extract)} />}>
        {/* In the studio's bar only the step's one primary action: « … avec le contrat supposé » stays with the contract. */}
        <SheetCard testid="contract-card" actions={inBar && assumedButton ? assumedButton : null}>
          <ContractPanel contract={contract} onChange={onChange} conformance={conformance} coverage={coverage} coverageState={coverageState} extract={extract} brief={brief} onBrief={onBrief} name={name} onName={onName} readOnly={readOnly || !onChange} />
        </SheetCard>
      </StudioSheet>
    </StepFrame>
  );
}
