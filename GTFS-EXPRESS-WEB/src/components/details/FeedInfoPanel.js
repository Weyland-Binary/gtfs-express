import React, { useState, useEffect, useCallback } from "react";
import {
  Box,
  Typography,
  TextField,
  Button,
  Alert,
  CircularProgress,
  Divider,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Chip,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import TranslateIcon from "@mui/icons-material/Translate";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import TranslationsRecordPanel from "../edit/TranslationsRecordPanel";

const FEED_INFO_TRANSLATABLE_FIELDS = [
  "feed_publisher_name",
  "feed_publisher_url",
];

/** Converts a Date object or ISO string to YYYYMMDD */
const toYYYYMMDD = (d) => {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return "";
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
};

const URL_RE = /^https?:\/\/.+/;
const LANG_RE = /^[a-z]{2,3}(-[A-Z0-9]{2,4})?$/;
const DATE_RE = /^\d{8}$/;

function buildEmptyForm() {
  return {
    feed_publisher_name: "",
    feed_publisher_url: "",
    feed_lang: "",
    default_lang: "",
    feed_start_date: "",
    feed_end_date: "",
    feed_version: "",
    feed_contact_email: "",
    feed_contact_url: "",
  };
}

function buildFormFromData(data) {
  return {
    feed_publisher_name: data.feed_publisher_name || "",
    feed_publisher_url: data.feed_publisher_url || "",
    feed_lang: data.feed_lang || "",
    default_lang: data.default_lang || "",
    feed_start_date: data.feed_start_date || "",
    feed_end_date: data.feed_end_date || "",
    feed_version: data.feed_version || "",
    feed_contact_email: data.feed_contact_email || "",
    feed_contact_url: data.feed_contact_url || "",
  };
}

function validate(form, t) {
  const errs = {};
  if (!form.feed_publisher_name.trim())
    errs.feed_publisher_name = t("feedInfo.errorRequired");
  if (!form.feed_publisher_url.trim())
    errs.feed_publisher_url = t("feedInfo.errorRequired");
  else if (!URL_RE.test(form.feed_publisher_url))
    errs.feed_publisher_url = t("feedInfo.errorUrl");
  if (!form.feed_lang.trim()) errs.feed_lang = t("feedInfo.errorRequired");
  else if (!LANG_RE.test(form.feed_lang))
    errs.feed_lang = t("feedInfo.errorLang");
  if (form.default_lang && !LANG_RE.test(form.default_lang))
    errs.default_lang = t("feedInfo.errorLang");
  if (form.feed_start_date && !DATE_RE.test(form.feed_start_date))
    errs.feed_start_date = t("feedInfo.errorDate");
  if (form.feed_end_date && !DATE_RE.test(form.feed_end_date))
    errs.feed_end_date = t("feedInfo.errorDate");
  if (
    !errs.feed_start_date &&
    !errs.feed_end_date &&
    form.feed_start_date &&
    form.feed_end_date &&
    form.feed_start_date > form.feed_end_date
  )
    errs.feed_end_date = t("feedInfo.errorDateRange");
  if (form.feed_contact_url && !URL_RE.test(form.feed_contact_url))
    errs.feed_contact_url = t("feedInfo.errorUrl");
  return errs;
}

function ReadOnlyField({ label, value }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
      <Typography variant="caption" color="text.secondary" fontWeight={600}>
        {label}
      </Typography>
      <Typography
        variant="body2"
        sx={{
          fontFamily: value ? undefined : "monospace",
          opacity: value ? 1 : 0.4,
        }}
      >
        {value || "—"}
      </Typography>
    </Box>
  );
}

function SectionBox({ children }) {
  return (
    <Box
      sx={{
        p: 1.5,
        borderRadius: 1.5,
        background: (theme) =>
          theme.palette.mode === "dark"
            ? "rgba(255,255,255,0.03)"
            : "rgba(0,0,0,0.02)",
        border: (theme) => `1px solid ${theme.palette.divider}`,
      }}
    >
      {children}
    </Box>
  );
}

/**
 * FeedInfoPanel — side panel content for viewing/editing feed_info.txt.
 * Rendered inside DetailPanel when entity.type === "feed_info".
 * No Dialog wrapper — just content that scrolls inside the Drawer.
 */
function FeedInfoPanel() {
  const { t } = useLanguage();
  const { editing, recordEdit, dataVersion } = useEditMode();
  const theme = useTheme();

  const [form, setForm] = useState(buildEmptyForm);
  const [fieldErrors, setFieldErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [apiError, setApiError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [hasExistingRow, setHasExistingRow] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Dates suggested from the GTFS calendar (calendar.txt + calendar_dates.txt)
  const [calendarRange, setCalendarRange] = useState(null); // { start: "YYYYMMDD", end: "YYYYMMDD" }

  // Load on mount
  useEffect(() => {
    setApiError(null);
    setFieldErrors({});
    setConfirmDelete(false);
    setLoading(true);
    const controller = new AbortController();

    // Fetch feed_info + statistics in parallel
    Promise.all([
      fetchWithSession(`${API_BASE_URL}/edit/feed_info`, {
        signal: controller.signal,
        cache: "no-store",
      })
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({})),
      fetchWithSession(`${API_BASE_URL}/statistics`, {
        signal: controller.signal,
        cache: "no-store",
      })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
      .then(([feedResp, statsResp]) => {
        // --- feed_info ---
        const row = (feedResp && feedResp.feed_info) || {};
        const isEmpty =
          !row || Object.keys(row).length === 0 || !row.feed_publisher_name;
        setHasExistingRow(!isEmpty);

        // --- Date range from the GTFS calendar ---
        const suggestedStart = toYYYYMMDD(statsResp?.calendarPeriod?.startDate);
        const suggestedEnd = toYYYYMMDD(statsResp?.calendarPeriod?.endDate);
        if (suggestedStart && suggestedEnd) {
          setCalendarRange({ start: suggestedStart, end: suggestedEnd });
        }

        // --- Form pre-fill ---
        const base = isEmpty ? buildEmptyForm() : buildFormFromData(row);
        // Pre-fill only if the field is empty in feed_info
        if (!base.feed_start_date && suggestedStart)
          base.feed_start_date = suggestedStart;
        if (!base.feed_end_date && suggestedEnd)
          base.feed_end_date = suggestedEnd;
        setForm(base);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          setApiError(err.message || "Network error");
          setForm(buildEmptyForm());
          setHasExistingRow(false);
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
    // dataVersion forces a refetch after any edit (undo/redo, SQL Console
    // mutation on feed_info, project import) so the form never shows stale
    // values relative to the actual DB row.
  }, [dataVersion]);

  const handleChange = useCallback((fieldName, value) => {
    setForm((prev) => ({ ...prev, [fieldName]: value }));
    setFieldErrors((prev) => {
      if (!prev[fieldName]) return prev;
      const next = { ...prev };
      delete next[fieldName];
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    const errs = validate(form, t);
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setSaving(true);
    setApiError(null);
    try {
      const payload = { ...form };
      [
        "default_lang",
        "feed_start_date",
        "feed_end_date",
        "feed_version",
        "feed_contact_email",
        "feed_contact_url",
      ].forEach((k) => {
        if (!payload[k]) delete payload[k];
      });
      const res = await fetchWithSession(`${API_BASE_URL}/edit/feed_info`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(
          body.error || t("edit.errors.saveFailed") || "Save failed",
        );
      recordEdit("Updated feed_info", body.validation, {
        entity: "feed_info",
        entityId: null,
      });
      setHasExistingRow(true);
    } catch (err) {
      setApiError(err.message || "Network error");
    } finally {
      setSaving(false);
    }
  }, [form, t, recordEdit]);

  const handleDeleteConfirm = useCallback(async () => {
    setDeleting(true);
    setApiError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/feed_info`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Delete failed");
      }
      recordEdit("Deleted feed_info", body.validation, {
        entity: "feed_info",
        entityId: null,
      });
      setHasExistingRow(false);
      setForm(buildEmptyForm());
      setConfirmDelete(false);
    } catch (err) {
      setApiError(err.message || "Network error");
    } finally {
      setDeleting(false);
    }
  }, [recordEdit]);

  const renderField = (name, label, extra = {}) => (
    <TextField
      fullWidth
      size="small"
      label={label}
      value={form[name]}
      onChange={(e) => handleChange(name, e.target.value)}
      error={Boolean(fieldErrors[name])}
      helperText={fieldErrors[name] || extra.helperText || undefined}
      {...extra}
    />
  );

  if (loading) {
    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          justifyContent: "center",
          py: 6,
        }}
      >
        <CircularProgress size={20} aria-busy="true" />
        <Typography variant="body2" color="text.secondary">
          {t("feedInfo.loading")}
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        pb: editing ? 10 : 2, // room for sticky footer
      }}
    >
      {apiError && (
        <Alert severity="error" onClose={() => setApiError(null)}>
          {apiError}
        </Alert>
      )}

      {/* Publisher section */}
      <SectionBox>
        <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1.5 }}>
          {t("feedInfo.sectionPublisher")}
        </Typography>
        {editing ? (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
            {renderField(
              "feed_publisher_name",
              t("feedInfo.publisherName") + " *",
            )}
            {renderField(
              "feed_publisher_url",
              t("feedInfo.publisherUrl") + " *",
              {
                placeholder: "https://example.com",
                type: "url",
              },
            )}
            {renderField("feed_lang", t("feedInfo.feedLang") + " *", {
              placeholder: "fr",
              helperText: "BCP-47 (e.g. fr, en-US)",
            })}
          </Box>
        ) : (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <ReadOnlyField
              label={t("feedInfo.publisherName")}
              value={form.feed_publisher_name}
            />
            <ReadOnlyField
              label={t("feedInfo.publisherUrl")}
              value={form.feed_publisher_url}
            />
            <ReadOnlyField
              label={t("feedInfo.feedLang")}
              value={form.feed_lang}
            />
          </Box>
        )}
      </SectionBox>

      {/* Validity section */}
      <SectionBox>
        <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1.5 }}>
          {t("feedInfo.sectionValidity")}
        </Typography>
        {editing ? (
          <>
            {/* Hint calendrier GTFS */}
            {calendarRange && (
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  mb: 1.5,
                  flexWrap: "wrap",
                }}
              >
                <Tooltip
                  title={t("feedInfo.calendarHint", {
                    start: calendarRange.start,
                    end: calendarRange.end,
                  })}
                >
                  <Chip
                    label={t("feedInfo.calendarHint", {
                      start: calendarRange.start,
                      end: calendarRange.end,
                    })}
                    size="small"
                    variant="outlined"
                    color="info"
                    sx={{
                      fontSize: 10,
                      fontFamily: "monospace",
                      maxWidth: "100%",
                    }}
                  />
                </Tooltip>
                {(form.feed_start_date !== calendarRange.start ||
                  form.feed_end_date !== calendarRange.end) && (
                  <Button
                    size="small"
                    variant="text"
                    color="info"
                    sx={{ fontSize: 11, py: 0, minWidth: 0 }}
                    onClick={() => {
                      handleChange("feed_start_date", calendarRange.start);
                      handleChange("feed_end_date", calendarRange.end);
                    }}
                  >
                    {t("feedInfo.calendarFill")}
                  </Button>
                )}
              </Box>
            )}
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 1.5,
                mb: 1.5,
              }}
            >
              {renderField("feed_start_date", t("feedInfo.startDate"), {
                placeholder: "20240101",
                inputProps: { maxLength: 8 },
              })}
              {renderField("feed_end_date", t("feedInfo.endDate"), {
                placeholder: "20241231",
                inputProps: { maxLength: 8 },
              })}
            </Box>
            {renderField("feed_version", t("feedInfo.version"), {
              placeholder: "1.0",
            })}
          </>
        ) : (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <Box
              sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1.5 }}
            >
              <ReadOnlyField
                label={t("feedInfo.startDate")}
                value={form.feed_start_date}
              />
              <ReadOnlyField
                label={t("feedInfo.endDate")}
                value={form.feed_end_date}
              />
            </Box>
            <ReadOnlyField
              label={t("feedInfo.version")}
              value={form.feed_version}
            />
          </Box>
        )}
      </SectionBox>

      {/* Contact section */}
      <SectionBox>
        <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1.5 }}>
          {t("feedInfo.sectionContact")}
        </Typography>
        {editing ? (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
            {renderField("feed_contact_email", t("feedInfo.contactEmail"), {
              type: "email",
              placeholder: "gtfs@example.com",
            })}
            {renderField("feed_contact_url", t("feedInfo.contactUrl"), {
              type: "url",
              placeholder: "https://example.com/gtfs",
            })}
            {renderField("default_lang", t("feedInfo.defaultLang"), {
              placeholder: "fr",
              helperText: "BCP-47 — optional",
            })}
          </Box>
        ) : (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <ReadOnlyField
              label={t("feedInfo.contactEmail")}
              value={form.feed_contact_email}
            />
            <ReadOnlyField
              label={t("feedInfo.contactUrl")}
              value={form.feed_contact_url}
            />
            <ReadOnlyField
              label={t("feedInfo.defaultLang")}
              value={form.default_lang}
            />
          </Box>
        )}
      </SectionBox>

      {/* Translations accordion — only when row exists */}
      {hasExistingRow && (
        <>
          <Divider />
          <Accordion
            disableGutters
            elevation={0}
            sx={{
              border: (theme) => `1px solid ${theme.palette.divider}`,
              borderRadius: "6px !important",
              "&:before": { display: "none" },
            }}
          >
            <AccordionSummary
              expandIcon={<ExpandMoreIcon />}
              sx={{
                minHeight: 36,
                "& .MuiAccordionSummary-content": { my: 0.75 },
              }}
            >
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                <TranslateIcon sx={{ fontSize: 15, opacity: 0.6 }} />
                <Typography
                  variant="caption"
                  fontWeight={600}
                  color="text.secondary"
                >
                  {t("translations.accordionTitle")}
                </Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails sx={{ pt: 0, pb: 1.5 }}>
              <TranslationsRecordPanel
                tableName="feed_info"
                recordId={null}
                fields={FEED_INFO_TRANSLATABLE_FIELDS}
              />
            </AccordionDetails>
          </Accordion>
        </>
      )}

      {!editing && !hasExistingRow && (
        <Box sx={{ py: 3, textAlign: "center" }}>
          <Typography variant="body2" color="text.secondary">
            {t("feedInfo.emptyStateReadOnly")}
          </Typography>
          <Typography
            variant="caption"
            color="text.disabled"
            sx={{ mt: 0.5, display: "block" }}
          >
            {t("app.editModeHint")}
          </Typography>
        </Box>
      )}

      {/* Sticky action footer — edit mode only */}
      {editing && (
        <Box
          sx={{
            position: "sticky",
            bottom: 0,
            left: 0,
            right: 0,
            mt: "auto",
            pt: 1.5,
            pb: 2,
            px: 0,
            borderTop: `1px solid ${theme.palette.divider}`,
            background: theme.palette.background.paper,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 1,
          }}
        >
          {hasExistingRow ? (
            <Button
              color="error"
              variant="outlined"
              size="small"
              onClick={() => setConfirmDelete(true)}
              disabled={saving || deleting}
              aria-label={t("feedInfo.deleteBtn")}
            >
              {t("feedInfo.deleteBtn")}
            </Button>
          ) : (
            <Box />
          )}
          <Button
            variant="contained"
            size="small"
            onClick={handleSave}
            disabled={saving || loading}
            startIcon={saving ? <CircularProgress size={14} /> : null}
          >
            {saving ? t("app.saving") : t("feedInfo.saveBtn")}
          </Button>
        </Box>
      )}

      {/* Delete confirmation dialog */}
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t("feedInfo.deleteConfirmTitle")}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {t("feedInfo.deleteConfirmBody")}
          </Typography>
          {apiError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {apiError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(false)} disabled={deleting}>
            {t("feedInfo.cancelBtn")}
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={handleDeleteConfirm}
            disabled={deleting}
          >
            {deleting ? (
              <CircularProgress size={18} />
            ) : (
              t("feedInfo.deleteBtn")
            )}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default FeedInfoPanel;
