/** « Modifier » in the community edition: modifying a network belongs to the hosted edition, which it points to. */
import React, { useState } from "react";
import { Button } from "@mui/material";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import HostedOnly from "../common/HostedOnly";

export function AssistantButton() {
  return null;
}

export default function ModifyMenu({ compact = false }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="contained"
        disableElevation
        startIcon={compact ? null : <EditOutlinedIcon />}
        onClick={() => setOpen(true)}
        data-testid="modify-menu"
        sx={{ textTransform: "none", fontWeight: 700, borderRadius: "10px", whiteSpace: "nowrap", height: 36, px: 1.75 }}
      >
        {t("modify.menu")}
      </Button>
      <HostedOnly variant="dialog" open={open} onClose={() => setOpen(false)} />
    </>
  );
}
