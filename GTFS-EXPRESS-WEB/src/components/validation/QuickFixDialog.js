import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  Alert,
  AlertTitle,
  CircularProgress,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Checkbox,
  Stack,
  Divider,
  IconButton,
  Tooltip,
} from "@mui/material";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";

const MONO = '"JetBrains Mono", "Fira Code", monospace';

const formatCell = (v) => {
  if (v === null || v === undefined || v === "") return "∅";
  return String(v);
};

/**
 * QuickFixDialog — auto-repair dialog for a single validation rule.
 *
 * Flow:
 *   1. "preview"  — fetch proposals from /edit/quickfix/preview, show diff table
 *                   with a per-row checkbox (all pre-selected)
 *   2. "applying" — POST /edit/quickfix/apply with the selected ids
 *   3. "result"   — success screen with applied count + close
 */
function QuickFixDialog({ open, onClose, ruleCode }) {
  const { t } = useLanguage();
  const { recordEdit } = useEditMode();

  const [step, setStep] = useState("preview");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [proposals, setProposals] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [result, setResult] = useState(null);
  const [meta, setMeta] = useState({ titleKey: null, descKey: null, entity: null });

  // Reset + fetch proposals each time the dialog opens or the ruleCode changes
  useEffect(() => {
    if (!open || !ruleCode) return;
    setStep("preview");
    setError(null);
    setResult(null);
    setSelected(new Set());
    setProposals([]);
    setLoading(true);

    fetchWithSession(`${API_BASE_URL}/edit/quickfix/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ruleCode }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        const list = Array.isArray(data.proposals) ? data.proposals : [];
        setProposals(list);
        setSelected(new Set(list.map((p) => String(p.id))));
        setMeta({
          titleKey: data.titleKey,
          descKey: data.descKey,
          entity: data.entity,
        });
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [open, ruleCode]);

  const fieldKeys = useMemo(() => {
    const set = new Set();
    for (const p of proposals) {
      for (const k of Object.keys(p.patch || {})) set.add(k);
    }
    return [...set];
  }, [proposals]);

  const allSelected =
    proposals.length > 0 && selected.size === proposals.length;
  const someSelected =
    selected.size > 0 && selected.size < proposals.length;

  const toggleRow = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = String(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (prev.size === proposals.length) return new Set();
      return new Set(proposals.map((p) => String(p.id)));
    });
  }, [proposals]);

  const handleApply = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const ids = [...selected];
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/quickfix/apply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ruleCode, ids }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setResult(body);
      setStep("result");
      // Quickfix can mutate many entities at once. Pass the validation block
      // (the API returns one — incremental validation runs scoped to the rule
      // code's affected files) so the inline UX surfaces any *new* findings
      // introduced by the bulk fix. No toast suffix override since this dialog
      // owns its own success message via the result step.
      recordEdit(null, body.validation, { entity: "quickfix", entityId: ruleCode });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }, [selected, ruleCode, recordEdit]);

  const title = meta.titleKey ? t(meta.titleKey) : ruleCode;
  const description = meta.descKey ? t(meta.descKey) : "";

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      maxWidth="lg"
      fullWidth
      PaperProps={{
        sx: { borderRadius: 2.5, minHeight: 520 },
      }}
    >
      <DialogTitle
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1.25,
          pb: 1,
        }}
      >
        <AutoFixHighIcon color="primary" sx={{ fontSize: 22 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
            {t("quickFix.dialog.title")}
          </Typography>
          <Typography
            variant="caption"
            sx={{
              fontFamily: MONO,
              color: "text.secondary",
              fontSize: "0.72rem",
            }}
          >
            {ruleCode}
          </Typography>
        </Box>
        {step === "preview" && (
          <Chip
            size="small"
            label={t("quickFix.dialog.proposalsCount", {
              count: proposals.length,
            })}
            color="primary"
            variant="outlined"
            sx={{ fontWeight: 700 }}
          />
        )}
      </DialogTitle>

      <Divider />

      <DialogContent sx={{ pt: 2 }}>
        {loading && (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 1.5,
              py: 6,
              color: "text.secondary",
            }}
          >
            <CircularProgress size={20} />
            <Typography variant="body2">
              {t("quickFix.dialog.loading")}
            </Typography>
          </Box>
        )}

        {!loading && error && step === "preview" && (
          <Alert severity="error" sx={{ mb: 2 }}>
            <AlertTitle>{t("quickFix.dialog.errorTitle")}</AlertTitle>
            {error}
          </Alert>
        )}

        {!loading && step === "preview" && (
          <>
            {description && (
              <Alert severity="info" icon={false} sx={{ mb: 2, borderRadius: 2 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.25 }}>
                  {title}
                </Typography>
                <Typography variant="body2">{description}</Typography>
              </Alert>
            )}

            {proposals.length === 0 ? (
              <Alert severity="success" sx={{ mt: 1 }}>
                {t("quickFix.dialog.nothingToFix")}
              </Alert>
            ) : (
              <Box
                sx={{
                  border: (th) => `1px solid ${th.palette.divider}`,
                  borderRadius: 2,
                  overflow: "hidden",
                  maxHeight: 380,
                  overflowY: "auto",
                }}
              >
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      <TableCell
                        padding="checkbox"
                        sx={{ bgcolor: "background.paper" }}
                      >
                        <Checkbox
                          size="small"
                          checked={allSelected}
                          indeterminate={someSelected}
                          onChange={toggleAll}
                        />
                      </TableCell>
                      <TableCell
                        sx={{
                          fontFamily: MONO,
                          fontSize: 11,
                          fontWeight: 700,
                          bgcolor: "background.paper",
                        }}
                      >
                        id
                      </TableCell>
                      {fieldKeys.map((k) => (
                        <TableCell
                          key={k}
                          sx={{
                            fontFamily: MONO,
                            fontSize: 11,
                            fontWeight: 700,
                            bgcolor: "background.paper",
                          }}
                        >
                          {k}
                        </TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {proposals.map((p) => {
                      const idKey = String(p.id);
                      const isChecked = selected.has(idKey);
                      return (
                        <TableRow
                          key={`${p.entity || ""}-${idKey}`}
                          hover
                          onClick={() => toggleRow(idKey)}
                          sx={{
                            cursor: "pointer",
                            opacity: isChecked ? 1 : 0.5,
                          }}
                        >
                          <TableCell padding="checkbox">
                            <Checkbox
                              size="small"
                              checked={isChecked}
                              onChange={() => toggleRow(idKey)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </TableCell>
                          <TableCell
                            sx={{
                              fontFamily: MONO,
                              fontSize: 11,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {p.entity && (
                              <Chip
                                size="small"
                                label={p.entity}
                                sx={{
                                  height: 16,
                                  mr: 0.75,
                                  fontFamily: MONO,
                                  fontSize: "0.6rem",
                                  bgcolor: (th) =>
                                    th.palette.mode === "dark"
                                      ? "rgba(255,255,255,0.08)"
                                      : "rgba(0,0,0,0.06)",
                                }}
                              />
                            )}
                            {idKey}
                          </TableCell>
                          {fieldKeys.map((k) => {
                            const hasCurrent =
                              p.current && k in p.current;
                            const hasPatch = p.patch && k in p.patch;
                            if (!hasCurrent && !hasPatch) {
                              return (
                                <TableCell
                                  key={k}
                                  sx={{ fontFamily: MONO, fontSize: 11, opacity: 0.35 }}
                                >
                                  —
                                </TableCell>
                              );
                            }
                            return (
                              <TableCell
                                key={k}
                                sx={{ fontFamily: MONO, fontSize: 11 }}
                              >
                                <Box
                                  sx={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 0.5,
                                    flexWrap: "wrap",
                                  }}
                                >
                                  <Box
                                    component="span"
                                    sx={{
                                      textDecoration: "line-through",
                                      opacity: 0.55,
                                    }}
                                  >
                                    {formatCell(p.current?.[k])}
                                  </Box>
                                  <Box component="span" sx={{ opacity: 0.5 }}>
                                    →
                                  </Box>
                                  <Box
                                    component="span"
                                    sx={{ color: "success.main", fontWeight: 700 }}
                                  >
                                    {formatCell(p.patch?.[k])}
                                  </Box>
                                </Box>
                              </TableCell>
                            );
                          })}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </Box>
            )}
          </>
        )}

        {step === "result" && result && (
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 1.5,
              py: 5,
            }}
          >
            <CheckCircleIcon color="success" sx={{ fontSize: 48 }} />
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              {t("quickFix.dialog.successTitle")}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t("quickFix.dialog.successDesc", {
                count: result.applied,
              })}
            </Typography>
            {result.skipped > 0 && (
              <Chip
                size="small"
                icon={<ErrorOutlineIcon />}
                label={t("quickFix.dialog.skippedCount", {
                  count: result.skipped,
                })}
                color="warning"
                variant="outlined"
              />
            )}
            <Typography
              variant="caption"
              color="text.disabled"
              sx={{ mt: 1.5 }}
            >
              {t("quickFix.dialog.undoHint")}
            </Typography>
          </Box>
        )}
      </DialogContent>

      <Divider />

      <DialogActions sx={{ px: 3, py: 1.5 }}>
        {step === "preview" && (
          <>
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              sx={{ flex: 1 }}
            >
              <Typography variant="caption" color="text.secondary">
                {t("quickFix.dialog.selectedCount", {
                  count: selected.size,
                  total: proposals.length,
                })}
              </Typography>
            </Stack>
            <Button onClick={onClose} disabled={saving}>
              {t("app.cancel")}
            </Button>
            <Button
              variant="contained"
              color="primary"
              startIcon={
                saving ? (
                  <CircularProgress size={14} color="inherit" />
                ) : (
                  <AutoFixHighIcon />
                )
              }
              disabled={saving || selected.size === 0 || proposals.length === 0}
              onClick={handleApply}
            >
              {saving
                ? t("quickFix.dialog.applying")
                : t("quickFix.dialog.applyBtn", { count: selected.size })}
            </Button>
          </>
        )}
        {step === "result" && (
          <Button variant="contained" onClick={onClose}>
            {t("app.close")}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

export default QuickFixDialog;
