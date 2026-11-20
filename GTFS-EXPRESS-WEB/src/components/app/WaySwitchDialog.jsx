// « Abandonner le brouillon en cours ? »: asked when the other way is chosen while the network's draft holds work.

import React from "react";
import { Box, Button, Dialog, DialogActions, DialogContent, Typography } from "@mui/material";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import DialogHeader from "../common/DialogHeader";
import { countWords } from "../../utils/countWords";
import { answerWaySwitch, useWaySwitchQuestion } from "../../utils/waySwitch";

function Fact({ lost = false, children, testid }) {
  const Icon = lost ? CloseRoundedIcon : CheckRoundedIcon;
  return (
    <Box component="li" data-testid={testid} sx={{ display: "flex", alignItems: "flex-start", gap: 1, fontSize: 13.5, lineHeight: 1.5 }}>
      <Icon aria-hidden sx={{ fontSize: 18, mt: "1px", color: lost ? "error.main" : "success.main" }} />
      <span>{children}</span>
    </Box>
  );
}

export default function WaySwitchDialog() {
  const { t } = useLanguage();
  const question = useWaySwitchQuestion();
  const wanted = question?.wanted === "brief" ? "brief" : "hand";
  const held = wanted === "hand" ? "brief" : "hand";
  const retouches = Number(question?.loss?.retouches) || 0;
  const close = () => answerWaySwitch(null);
  return (
    <Dialog open={Boolean(question)} onClose={close} fullWidth maxWidth="sm" aria-labelledby="way-switch-title" aria-describedby="way-switch-lead" data-testid="way-switch-dialog" data-wanted={wanted}>
      <DialogHeader icon={wanted === "hand" ? <EditOutlinedIcon /> : <DescriptionOutlinedIcon />} tone="warning" title={t("draft.switch.title")} subtitle={question?.network || null} titleId="way-switch-title" onClose={close} closeTestId="way-switch-close" />
      <DialogContent>
        <Typography id="way-switch-lead" sx={{ fontSize: 13.5, lineHeight: 1.5 }}>
          {t(`draft.switch.lead.${wanted}`)}
        </Typography>
        <Box component="ul" sx={{ listStyle: "none", m: 0, mt: 1.5, p: 0, display: "flex", flexDirection: "column", gap: 0.75 }}>
          <Fact lost testid="way-switch-lost">
            {held === "brief" ? t("draft.switch.lost.brief") : retouches > 0 ? countWords(t, "draft.switch.lost.hand", retouches) : t("draft.switch.lost.plan")}
          </Fact>
          {held === "brief" && <Fact testid="way-switch-kept-brief">{t("draft.switch.keptBrief")}</Fact>}
          <Fact testid="way-switch-kept-network">{t("draft.switch.keptNetwork")}</Fact>
        </Box>
        <Typography data-testid="way-switch-tip" sx={{ mt: 1.75, fontSize: 12.5, lineHeight: 1.5, color: "text.secondary" }}>
          {t(`draft.switch.tip.${held}`)}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" autoFocus onClick={() => answerWaySwitch("resume")} data-testid="way-switch-resume">
          {t("draft.switch.resume")}
        </Button>
        <Button variant="contained" color="error" disableElevation onClick={() => answerWaySwitch("switch")} data-testid="way-switch-go">
          {t(`draft.switch.go.${wanted}`)}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
