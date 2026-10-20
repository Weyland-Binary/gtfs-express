/**
 * MemoryChip — the assistant's session memory, in the chat header: how many
 * facts it holds, and a popover to read, add, forget them and to un-mute
 * Diagnostic findings.
 */

import React, { useState } from "react";
import { Box, Chip, IconButton, InputBase, Popover, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import PsychologyOutlinedIcon from "@mui/icons-material/PsychologyOutlined";
import CloseIcon from "@mui/icons-material/Close";
import AddIcon from "@mui/icons-material/Add";
import VisibilityOffOutlinedIcon from "@mui/icons-material/VisibilityOffOutlined";
import DeleteSweepOutlinedIcon from "@mui/icons-material/DeleteSweepOutlined";
import { useLanguage } from "../../contexts/LanguageContext";

export default function MemoryChip({ memory, onUpdate }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [anchor, setAnchor] = useState(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const notes = memory?.notes || [];
  const ignored = memory?.ignoredFindings || [];
  const count = notes.length + ignored.length;

  const run = async (change) => {
    if (busy) return;
    setBusy(true);
    try {
      await onUpdate(change);
    } catch {
      /* the hook keeps the last state */
    } finally {
      setBusy(false);
    }
  };

  const addNote = async () => {
    const text = draft.trim();
    if (text.length < 3) return;
    await run({ addNotes: [text] });
    setDraft("");
  };

  return (
    <>
      <Tooltip title={t("chat.memory.chip", { count })}>
        <Chip
          size="small"
          icon={<PsychologyOutlinedIcon sx={{ fontSize: 14 }} />}
          label={count}
          onClick={(e) => setAnchor(e.currentTarget)}
          data-testid="chat-memory-chip"
          sx={{
            height: 22,
            fontSize: "0.66rem",
            fontWeight: 700,
            color: count ? theme.palette.ai.dark : "text.secondary",
            bgcolor: alpha(theme.palette.ai.main, count ? 0.12 : 0.05),
            "& .MuiChip-icon": { color: count ? theme.palette.ai.main : "text.disabled" },
          }}
        />
      </Tooltip>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        PaperProps={{ sx: { width: 320, p: 1.5, borderRadius: 2 } }}
        data-testid="chat-memory-popover"
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mb: 0.75 }}>
          <PsychologyOutlinedIcon sx={{ fontSize: 18, color: theme.palette.ai.main }} />
          <Typography sx={{ fontWeight: 800, fontSize: "0.86rem", flex: 1 }}>{t("chat.memory.title")}</Typography>
          {count > 0 && (
            <Tooltip title={t("chat.memory.clear")}>
              <IconButton size="small" onClick={() => run({ clear: true })} disabled={busy} aria-label={t("chat.memory.clear")}>
                <DeleteSweepOutlinedIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          )}
        </Box>
        <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.45, mb: 1 }}>{t("chat.memory.hint")}</Typography>

        {notes.length > 0 && (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.4, mb: 1 }}>
            {notes.map((n) => (
              <Box key={n.id} sx={{ display: "flex", alignItems: "flex-start", gap: 0.5, px: 0.75, py: 0.4, borderRadius: 1, background: alpha(theme.palette.ai.main, 0.06), fontSize: "0.74rem", lineHeight: 1.4 }}>
                <Box sx={{ flex: 1 }}>{n.text}</Box>
                <IconButton size="small" onClick={() => run({ removeNoteIds: [n.id] })} disabled={busy} aria-label={t("chat.memory.forget")} sx={{ p: 0.2 }}>
                  <CloseIcon sx={{ fontSize: 13 }} />
                </IconButton>
              </Box>
            ))}
          </Box>
        )}
        {ignored.length > 0 && (
          <Box sx={{ mb: 1 }}>
            <Typography sx={{ fontSize: "0.66rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: "text.secondary", mb: 0.4 }}>{t("chat.memory.ignored")}</Typography>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.4 }}>
              {ignored.map((code) => (
                <Chip
                  key={code}
                  size="small"
                  icon={<VisibilityOffOutlinedIcon sx={{ fontSize: 12 }} />}
                  label={code}
                  onDelete={() => run({ unignore: [code] })}
                  disabled={busy}
                  sx={{ height: 20, fontSize: "0.62rem", fontFamily: "monospace" }}
                />
              ))}
            </Box>
          </Box>
        )}
        {count === 0 && <Typography sx={{ fontSize: "0.74rem", color: "text.disabled", mb: 1 }}>{t("chat.memory.empty")}</Typography>}

        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, borderRadius: 1, border: `1px solid ${alpha(theme.palette.divider, 1)}`, px: 1, py: 0.25 }}>
          <InputBase
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, 240))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addNote();
              }
            }}
            placeholder={t("chat.memory.addPlaceholder")}
            inputProps={{ "data-testid": "chat-memory-input" }}
            sx={{ flex: 1, fontSize: "0.76rem" }}
          />
          <IconButton size="small" onClick={addNote} disabled={busy || draft.trim().length < 3} aria-label={t("chat.memory.add")}>
            <AddIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Box>
      </Popover>
    </>
  );
}
