/**
 * ChangeStudio — change the loaded network the way a brief asks.
 *
 * Left: the brief (typed, or documents: a service-change notice, a
 * contract amendment…) and the conversation with the change planner, which
 * reads the feed and writes a CHANGE PLAN of typed operations, each citing
 * the brief. Right: the plan under review — every step with the engine's
 * verdict (applied, blocked with its questions, failed), the changes as a
 * passenger or an operator reads them, and the checks (the brief's clauses
 * before → after, integrity, the canonical validator). Nothing touches the
 * feed until "Apply": the whole plan then becomes ONE edit, undone in one
 * click.
 *
 * Without the assistant the studio still works: operations are added from
 * the catalogue with a form, previewed and applied the same way.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Chip, CircularProgress, Dialog, IconButton, InputBase, Tab, Tabs, Tooltip, Typography, alpha, useMediaQuery, useTheme } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import AutoFixHighOutlinedIcon from "@mui/icons-material/AutoFixHighOutlined";
import ArrowUpwardRoundedIcon from "@mui/icons-material/ArrowUpwardRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import AttachFileRoundedIcon from "@mui/icons-material/AttachFileRounded";
import AddIcon from "@mui/icons-material/Add";
import RefreshIcon from "@mui/icons-material/Refresh";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import PlaylistAddCheckIcon from "@mui/icons-material/PlaylistAddCheck";
import CompareArrowsIcon from "@mui/icons-material/CompareArrows";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import TrainOutlinedIcon from "@mui/icons-material/TrainOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { useFeatures } from "../../utils/featuresApi";
import MarkdownText from "../chat/MarkdownText";
import { BRIEF_ACCEPT, uploadBriefDocument, deleteBriefDocument } from "../../utils/networkStudioApi";
import { fetchOperations, fetchOverview, fetchHealth, previewChangePlan, commitChangePlan, streamChangePlan, withParam, nextOpId } from "../../utils/transformApi";
import { OperationCard, OperationDialog, ChangesPanel, ChecksPanel, NetworkHealthCard } from "./ChangePlanParts";
import { soft } from "../network/StudioUI";
import ReferencesDialog from "./ReferencesDialog";

const EMPTY_PLAN = { title: "", operations: [] };
const MAX_DOCUMENTS = 5;
const TOOL_LABEL = { lookup: "lookup", route_timetable: "timetable", reference_timetable: "timetable", set_plan: "plan", patch_plan: "plan", ask_user: "questions" };

export default function ChangeStudio({ open, onClose, initialPlan = null }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const { editing, enterEditMode, recordEdit } = useEditMode();
  const { features } = useFeatures();
  const aiEnabled = Boolean(features?.chat?.enabled);

  const [catalogue, setCatalogue] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [health, setHealth] = useState(null);
  const [plan, setPlan] = useState(EMPTY_PLAN);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [validating, setValidating] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [turns, setTurns] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [documents, setDocuments] = useState([]);
  const [tab, setTab] = useState("plan");
  const [dialog, setDialog] = useState(null); // { initial } for add/edit
  const [refsOpen, setRefsOpen] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  const fileRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    fetchOperations()
      .then((d) => setCatalogue(d.operations || []))
      .catch(() => setCatalogue([]));
    fetchOverview()
      .then((d) => setRoutes(d.routes || []))
      .catch(() => setRoutes([]));
    // The feed as it is now, on the yardstick every preview compares against.
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, [open]);
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  const refresh = useCallback(async (next, { validate = false } = {}) => {
    if (!next.operations.length) {
      setPreview(null);
      return null;
    }
    setError(null);
    if (validate) setValidating(true);
    else setPreviewing(true);
    try {
      const p = await previewChangePlan(next, { validate });
      setPreview(p);
      return p;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setPreviewing(false);
      setValidating(false);
    }
  }, []);

  // A plan handed over (e.g. by the chat assistant) replaces the current one.
  useEffect(() => {
    if (!open || !initialPlan || !Array.isArray(initialPlan.operations)) return;
    setPlan(initialPlan);
    setTab("plan");
    refresh(initialPlan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPlan]);

  const updatePlan = useCallback(
    (next) => {
      setPlan(next);
      refresh(next);
    },
    [refresh],
  );

  // ── The planner ──
  const runPlanner = useCallback(
    async (text) => {
      const brief = String(text || "").trim();
      if (!brief || streaming) return;
      setInput("");
      setError(null);
      const history = turns.filter((x) => x.text).map((x) => ({ role: x.role, content: x.text }));
      setTurns((ts) => [...ts, { role: "user", text: brief }, { role: "assistant", text: "", steps: [], questions: [], pending: null }]);
      const patchLast = (fn) => setTurns((ts) => ts.map((x, i) => (i === ts.length - 1 ? fn(x) : x)));
      const abort = new AbortController();
      abortRef.current = abort;
      setStreaming(true);
      try {
        await streamChangePlan({
          brief,
          plan: plan.operations.length ? plan : null,
          messages: history,
          language,
          documents: documents.filter((d) => d.status === "ready").map((d) => d.id),
          signal: abort.signal,
          onEvent: (event, data) => {
            if (event === "token") patchLast((x) => ({ ...x, text: x.text + (data.text || "") }));
            else if (event === "tool_pending") patchLast((x) => ({ ...x, pending: data.name }));
            else if (event === "plan") {
              setPlan(data);
              patchLast((x) => ({ ...x, pending: null, steps: [...x.steps, { kind: "plan", count: data.operations?.length || 0 }] }));
            } else if (event === "preview") {
              setPreview(data);
              setTab("plan");
            } else if (event === "questions") patchLast((x) => ({ ...x, questions: data.questions || [] }));
            else if (event === "error") patchLast((x) => ({ ...x, error: data.message || data.code }));
            else if (event === "done") patchLast((x) => ({ ...x, pending: null, done: data }));
          },
        });
      } catch (err) {
        if (err.code !== "ABORTED") patchLast((x) => ({ ...x, error: err.message }));
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [streaming, turns, plan, language, documents],
  );
  const stopPlanner = () => abortRef.current?.abort();

  const attach = async (files) => {
    for (const file of Array.from(files || []).slice(0, MAX_DOCUMENTS - documents.length)) {
      const key = `${file.name}-${file.size}-${file.lastModified}`;
      setDocuments((ds) => [...ds, { key, name: file.name, size: file.size, status: "uploading" }]);
      try {
        const d = await uploadBriefDocument(file);
        setDocuments((ds) => ds.map((x) => (x.key === key ? { ...x, ...d, status: "ready" } : x)));
      } catch (err) {
        setDocuments((ds) => ds.map((x) => (x.key === key ? { ...x, status: "error", error: err.message } : x)));
      }
    }
  };
  const removeDocument = (doc) => {
    if (doc.id) deleteBriefDocument(doc.id);
    setDocuments((ds) => ds.filter((x) => x.key !== doc.key));
  };

  // ── Editing the plan by hand ──
  const answer = (opId, param, value) => updatePlan(withParam(plan, opId, param, value));
  const removeOp = (id) => updatePlan({ ...plan, operations: plan.operations.filter((o) => o.id !== id) });
  const moveOp = (id, dir) => {
    const ops = [...plan.operations];
    const i = ops.findIndex((o) => o.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ops.length) return;
    [ops[i], ops[j]] = [ops[j], ops[i]];
    updatePlan({ ...plan, operations: ops });
  };
  const saveOp = (op) => {
    const exists = op.id && plan.operations.some((o) => o.id === op.id);
    const next = exists ? { ...plan, operations: plan.operations.map((o) => (o.id === op.id ? op : o)) } : { ...plan, operations: [...plan.operations, { ...op, id: nextOpId(plan) }] };
    setDialog(null);
    updatePlan(next);
  };
  const reset = () => {
    stopPlanner();
    setPlan(EMPTY_PLAN);
    setPreview(null);
    setTurns([]);
    setError(null);
  };

  // ── Apply ──
  const stepOf = (id) => (preview?.steps || []).find((s) => s.id === id) || null;
  const blockedCount = (preview?.steps || []).filter((s) => s.status === "blocked" || s.status === "failed").length;
  const failingClauses = (preview?.conformance?.after?.results || []).filter((r) => r.level === "must" && r.status === "fail").length;
  const canApply = Boolean(preview?.id) && !preview.blocked && !(preview.integrity || []).length && !previewing && !streaming && !committing;
  const apply = async () => {
    if (!canApply) return;
    setCommitting(true);
    setError(null);
    try {
      let previewId = preview.id;
      if (!editing) {
        // Entering edit mode may rebuild the session database: preview again on it.
        const entered = await enterEditMode();
        if (!entered?.ok) {
          setError(entered?.message || t("transform.editRequired"));
          return;
        }
        const again = await refresh(plan);
        if (!again?.id || again.blocked || (again.integrity || []).length) {
          setError(t("transform.stale"));
          return;
        }
        previewId = again.id;
      }
      const out = await commitChangePlan(previewId);
      recordEdit(t("transform.applied", { title: out.description || plan.title || "" }), null, { entity: "transform", entityId: (out.tables || []).join(",") });
      reset();
      onClose();
    } catch (err) {
      if (err.code === "PREVIEW_STALE" || err.code === "PREVIEW_NOT_FOUND") {
        setError(t("transform.stale"));
        refresh(plan);
      } else setError(err.message);
    } finally {
      setCommitting(false);
    }
  };

  const statusLine = !plan.operations.length ? t("transform.emptyPlan") : previewing ? t("transform.previewing") : !preview ? t("transform.noPreview") : preview.empty ? t("transform.noChanges") : blockedCount ? t("transform.blocked", { count: blockedCount }) : (preview.integrity || []).length ? t("transform.integrityProblems") : failingClauses ? t("transform.clausesFailing", { count: failingClauses }) : t("transform.ready");
  const readyTone = canApply && !failingClauses ? "success" : blockedCount || (preview?.integrity || []).length ? "warning" : "info";

  return (
    <Dialog open={open} onClose={onClose} fullScreen PaperProps={{ sx: { background: theme.palette.background.default } }} data-testid="change-studio">
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, px: 2, py: 1, borderBottom: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper }}>
        <Box sx={{ width: 34, height: 34, borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart}, ${theme.palette.ai.gradientEnd})`, color: theme.palette.ai.contrastText }}>
          <AutoFixHighOutlinedIcon sx={{ fontSize: 20 }} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 800, fontSize: "1rem", lineHeight: 1.2 }}>{t("transform.title")}</Typography>
          <Typography sx={{ fontSize: "0.74rem", color: "text.secondary" }} noWrap>
            {plan.title || t("transform.subtitle")}
          </Typography>
        </Box>
        <Tooltip title={t("transform.references.title")}>
          <IconButton size="small" onClick={() => setRefsOpen(true)} aria-label={t("transform.references.title")} data-testid="change-references-open">
            <TrainOutlinedIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title={t("transform.startOver")}>
          <span>
            <IconButton size="small" onClick={reset} disabled={streaming || committing} aria-label={t("transform.startOver")} data-testid="change-reset">
              <RestartAltIcon />
            </IconButton>
          </span>
        </Tooltip>
        <IconButton size="small" onClick={onClose} aria-label={t("app.close")} data-testid="change-close">
          <CloseIcon />
        </IconButton>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: isMobile ? "column" : "row" }}>
        {/* The brief and the conversation */}
        <Box sx={{ width: isMobile ? "100%" : 400, flexShrink: 0, borderRight: isMobile ? "none" : `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper, minHeight: isMobile ? 320 : 0, display: "flex", flexDirection: "column" }}>
          <Box ref={scrollRef} sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 1.5, display: "flex", flexDirection: "column", gap: 1.25 }}>
            {!turns.length && (
              <Box sx={{ p: 1.5, borderRadius: "12px", background: soft(theme) }} data-testid="change-welcome">
                <Typography sx={{ fontSize: "0.86rem", fontWeight: 800, mb: 0.5 }}>{t("transform.welcome.title")}</Typography>
                <Typography sx={{ fontSize: "0.76rem", color: "text.secondary", lineHeight: 1.55 }}>{aiEnabled ? t("transform.welcome.hint") : t("transform.welcome.manual")}</Typography>
                {aiEnabled && (
                  <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, mt: 1 }}>
                    {["a", "b", "c"].map((k) => (
                      <Chip key={k} size="small" variant="outlined" label={t(`transform.example.${k}`)} onClick={() => setInput(t(`transform.example.${k}`))} sx={{ justifyContent: "flex-start", height: "auto", py: 0.5, "& .MuiChip-label": { whiteSpace: "normal", fontSize: "0.72rem" } }} />
                    ))}
                  </Box>
                )}
              </Box>
            )}
            {turns.map((turn, i) =>
              turn.role === "user" ? (
                <Box key={i} sx={{ alignSelf: "flex-end", maxWidth: "88%", px: 1.25, py: 0.75, borderRadius: "12px 12px 4px 12px", background: alpha(theme.palette.primary.main, 0.1) }}>
                  <Typography sx={{ fontSize: "0.8rem", whiteSpace: "pre-wrap" }}>{turn.text}</Typography>
                </Box>
              ) : (
                <Box key={i} data-testid="change-assistant-turn" sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
                  {turn.text && <MarkdownText text={turn.text} />}
                  {turn.pending && (
                    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, color: "text.secondary" }}>
                      <CircularProgress size={12} />
                      <Typography sx={{ fontSize: "0.72rem" }}>{t(`transform.tool.${TOOL_LABEL[turn.pending] || "work"}`)}</Typography>
                    </Box>
                  )}
                  {turn.steps.map((s, j) => (
                    <Chip key={j} size="small" icon={<PlaylistAddCheckIcon sx={{ fontSize: 14 }} />} label={t("transform.step.plan", { count: s.count })} sx={{ alignSelf: "flex-start", height: 22, fontSize: "0.68rem" }} />
                  ))}
                  {(turn.questions || []).length > 0 && (
                    <Box sx={{ p: 1, borderRadius: "10px", background: alpha(theme.palette.warning.main, 0.08), display: "flex", flexDirection: "column", gap: 0.75 }} data-testid="change-planner-questions">
                      {turn.questions.map((q, k) => (
                        <Box key={k}>
                          <Typography sx={{ fontSize: "0.76rem", fontWeight: 600 }}>{q.text}</Typography>
                          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 0.5 }}>
                            {(q.options || []).map((o) => (
                              <Chip key={o} size="small" label={o} color={q.default === o ? "primary" : "default"} variant={q.default === o ? "filled" : "outlined"} disabled={streaming} onClick={() => (q.operation && q.param && plan.operations.some((op) => op.id === q.operation) ? answer(q.operation, q.param, o) : runPlanner(`${q.text} → ${o}`))} sx={{ fontSize: "0.7rem" }} />
                            ))}
                          </Box>
                        </Box>
                      ))}
                    </Box>
                  )}
                  {turn.error && <Alert severity="error" sx={{ py: 0, fontSize: "0.74rem" }}>{turn.error}</Alert>}
                </Box>
              ),
            )}
          </Box>
          {/* Composer */}
          <Box sx={{ p: 1.25, borderTop: `1px solid ${theme.palette.divider}` }}>
            {documents.length > 0 && (
              <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mb: 0.75 }}>
                {documents.map((d) => (
                  <Chip key={d.key} size="small" icon={d.status === "uploading" ? <CircularProgress size={10} /> : <DescriptionOutlinedIcon sx={{ fontSize: 14 }} />} label={d.name} color={d.status === "error" ? "error" : "default"} onDelete={() => removeDocument(d)} title={d.error || d.name} sx={{ maxWidth: 220, fontSize: "0.7rem" }} data-testid="change-document" />
                ))}
              </Box>
            )}
            <Box sx={{ display: "flex", alignItems: "flex-end", gap: 0.75, p: 0.75, borderRadius: "14px", boxShadow: `0 0 0 1px ${theme.palette.divider}`, background: theme.palette.background.default }}>
              <input ref={fileRef} type="file" hidden multiple accept={BRIEF_ACCEPT} onChange={(e) => { attach(e.target.files); e.target.value = ""; }} data-testid="change-file" />
              <Tooltip title={t("transform.attach")}>
                <span>
                  <IconButton size="small" disabled={!aiEnabled || streaming || documents.length >= MAX_DOCUMENTS} onClick={() => fileRef.current?.click()} aria-label={t("transform.attach")}>
                    <AttachFileRoundedIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <InputBase
                multiline
                maxRows={8}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    runPlanner(input);
                  }
                }}
                disabled={!aiEnabled}
                placeholder={aiEnabled ? t("transform.placeholder") : t("transform.aiDisabled")}
                inputProps={{ "data-testid": "change-brief" }}
                sx={{ flex: 1, fontSize: "0.82rem", px: 0.5 }}
              />
              {streaming ? (
                <IconButton size="small" onClick={stopPlanner} aria-label={t("transform.stop")} data-testid="change-stop">
                  <StopRoundedIcon />
                </IconButton>
              ) : (
                <IconButton size="small" color="primary" disabled={!aiEnabled || !input.trim()} onClick={() => runPlanner(input)} aria-label={t("transform.send")} data-testid="change-send">
                  <ArrowUpwardRoundedIcon />
                </IconButton>
              )}
            </Box>
          </Box>
        </Box>

        {/* The plan under review */}
        <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <Box sx={{ display: "flex", alignItems: "center", px: 1.5, borderBottom: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper }}>
            <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ flex: 1, minHeight: 40, "& .MuiTab-root": { minHeight: 40, textTransform: "none", fontWeight: 600, fontSize: "0.8rem" } }}>
              <Tab value="plan" icon={<PlaylistAddCheckIcon sx={{ fontSize: 16 }} />} iconPosition="start" label={`${t("transform.tab.plan")}${plan.operations.length ? ` (${plan.operations.length})` : ""}`} data-testid="change-tab-plan" />
              <Tab value="changes" icon={<CompareArrowsIcon sx={{ fontSize: 16 }} />} iconPosition="start" label={`${t("transform.tab.changes")}${preview?.diff?.items?.length ? ` (${preview.diff.items.length})` : ""}`} data-testid="change-tab-changes" />
              <Tab value="checks" icon={<FactCheckOutlinedIcon sx={{ fontSize: 16 }} />} iconPosition="start" label={t("transform.tab.checks")} data-testid="change-tab-checks" />
            </Tabs>
            <Button size="small" startIcon={<AddIcon />} onClick={() => setDialog({ initial: null })} disabled={streaming} data-testid="change-add" sx={{ textTransform: "none", fontWeight: 700 }}>
              {t("transform.addOperation")}
            </Button>
          </Box>
          <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 1.5 }}>
            {error && (
              <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError(null)}>
                {error}
              </Alert>
            )}
            {tab === "plan" && (
              <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                {!plan.operations.length && <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", p: 1 }}>{t("transform.emptyPlanHint")}</Typography>}
                {!plan.operations.length && <NetworkHealthCard health={health} />}
                {plan.operations.map((op, i) => (
                  <OperationCard key={op.id} op={op} step={stepOf(op.id)} def={catalogue.find((c) => c.type === op.type)} index={i} count={plan.operations.length} busy={streaming || previewing || committing} onAnswer={answer} onRemove={removeOp} onMove={moveOp} onEdit={(o) => setDialog({ initial: o })} />
                ))}
                {(plan.assumptions || []).length > 0 && (
                  <Box sx={{ p: 1.25, borderRadius: "12px", background: soft(theme) }} data-testid="change-assumptions">
                    <Typography sx={{ fontSize: "0.78rem", fontWeight: 800, mb: 0.5 }}>{t("transform.assumptions")}</Typography>
                    {plan.assumptions.map((a, i) => (
                      <Typography key={i} sx={{ fontSize: "0.74rem", lineHeight: 1.5 }}>
                        • {a.text}
                        {a.confidence ? ` (${t(`transform.confidence.${a.confidence}`)})` : ""}
                      </Typography>
                    ))}
                  </Box>
                )}
              </Box>
            )}
            {tab === "changes" && <ChangesPanel preview={preview} />}
            {tab === "checks" && <ChecksPanel preview={preview} validating={validating} onValidate={() => refresh(plan, { validate: true })} />}
          </Box>
          {/* Verdict and apply */}
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.5, py: 1, borderTop: `1px solid ${theme.palette.divider}`, background: theme.palette.background.paper }}>
            <Typography data-testid="change-status" sx={{ flex: 1, fontSize: "0.78rem", fontWeight: 600, color: `${readyTone}.main` }}>
              {statusLine}
            </Typography>
            <Tooltip title={t("transform.previewAgain")}>
              <span>
                <IconButton size="small" onClick={() => refresh(plan)} disabled={!plan.operations.length || previewing || streaming} aria-label={t("transform.previewAgain")} data-testid="change-refresh">
                  {previewing ? <CircularProgress size={16} /> : <RefreshIcon />}
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={canApply ? t("transform.applyHint") : ""}>
              <span>
                <Button variant="contained" disableElevation disabled={!canApply} onClick={apply} data-testid="change-apply" startIcon={committing ? <CircularProgress size={14} color="inherit" /> : null} sx={{ textTransform: "none", fontWeight: 800, borderRadius: 99, px: 2.5 }}>
                  {editing ? t("transform.apply") : t("transform.applyEdit")}
                </Button>
              </span>
            </Tooltip>
          </Box>
        </Box>
      </Box>
      <OperationDialog open={Boolean(dialog)} catalogue={catalogue} routes={routes} initial={dialog?.initial || null} onClose={() => setDialog(null)} onSave={saveOp} />
      <ReferencesDialog open={refsOpen} onClose={() => setRefsOpen(false)} />
    </Dialog>
  );
}
