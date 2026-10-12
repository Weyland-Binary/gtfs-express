/**
 * ProseWithStrikes — the model's prose after the engine's verdict, with the
 * sentences the verdict contradicts struck through (target design §6.1, M-2).
 *
 * `prose` is the `prose` field of the SSE `verdict` event as the planners
 * emit it (services/verdict.contradictionsOf): `{ claims_all_met,
 * wrong_count, contradicts, spans: [{ start, end, text, reason }] }`, the
 * offsets in the turn's text. Each span is a `<del>` (testid prose-struck)
 * followed by "the engine says otherwise" (testid verdict-contradiction),
 * which the `<del>` names with aria-describedby (chat/MarkdownText draws
 * them). A sentence claiming the person's objectives were changed (reason
 * claims_contract_change: the assistant only proposes their correction, the
 * person applies it) is followed by why instead — no objective changed —
 * and titled so: the verdict does not contradict it (each span's title is
 * its reason's).
 * `data-contradicts` carries the detector's answer for the e2e and the
 * evaluation harness.
 *
 * Before the verdict (the turn still streams, or it ended without the
 * event) the words are the model's unchecked claim: `unchecked` renders them
 * muted under a short note (testid prose-unchecked, "not yet checked by the
 * engine"), `data-checked="false"`, nothing struck — never as plain text a
 * reader could take for the verdict (M-2).
 */

import React from "react";
import { Box, Typography } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import MarkdownText from "../chat/MarkdownText";

export default function ProseWithStrikes({ text, prose = null, muted = false, unchecked = false, testid = "prose" }) {
  const { t } = useLanguage();
  if (unchecked) {
    return (
      <Box data-testid={testid} data-contradicts="false" data-checked="false">
        <Typography data-testid="prose-unchecked" sx={{ fontSize: "0.7rem", fontStyle: "italic", color: "text.secondary", mb: 0.5 }}>
          {t("verdict.unchecked")}
        </Typography>
        <MarkdownText text={text} muted />
      </Box>
    );
  }
  const spans = Array.isArray(prose?.spans) && prose.spans.length ? prose.spans : null;
  return (
    <Box data-testid={testid} data-contradicts={prose?.contradicts ? "true" : "false"} data-checked="true">
      <MarkdownText text={text} muted={muted} spans={spans} strikeNote={t("verdict.contradiction")} strikeNotes={{ claims_contract_change: t("verdict.contractChange") }} strikeTitle={t("verdict.struck")} strikeTitles={{ claims_contract_change: t("verdict.struck.contractChange") }} />
    </Box>
  );
}
