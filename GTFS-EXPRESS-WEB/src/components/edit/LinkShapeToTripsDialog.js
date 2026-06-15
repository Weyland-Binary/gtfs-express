import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  Chip,
  Checkbox,
  TextField,
  Autocomplete,
  ToggleButton,
  ToggleButtonGroup,
  CircularProgress,
  Divider,
  Stack,
} from "@mui/material";
import { useTheme, alpha } from "@mui/material/styles";
import LinkIcon from "@mui/icons-material/Link";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import API_BASE_URL from "../../config";

// Hard cap on the number of trips loaded into the dialog. Beyond this we
// redirect the user to the SQL Console (which can stream-paginate large feeds).
const TRIP_LOAD_LIMIT = 5000;

// Above this threshold the backend requires `confirmedLargeMutation: true`.
// We mirror the same UX threshold here: an Alert warns the user and the
// flag is forwarded to /edit/sql.
const LARGE_MUTATION_THRESHOLD = 1000;

// Incremental render window — same pattern as SqlConsole's visibleRows
// scroll-virtualization. Mounting all 5000 rows at once eats ~30ms on a
// mid-range laptop; 200/page keeps the open animation buttery.
const VIRT_PAGE = 200;

// Quote a single SQL string literal: escape any embedded apostrophe by
// doubling it. Used to inline trip_ids into the IN(...) list. We never let
// raw user input reach this — values come from the SELECT result of the
// trips table, but we still escape defensively against feeds that contain
// trip_ids with apostrophes (rare but legal).
function sqlQuoteString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function LinkShapeToTripsDialog({
  open,
  onClose,
  shapeId,
  pointCount,
  distanceKm,
  onLinked,
}) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { editing, recordEdit, enterEditMode } = useEditMode();

  // ── State ─────────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [tooLarge, setTooLarge] = useState(false);

  const [trips, setTrips] = useState([]); // [{ trip_id, route_id, direction_id, trip_headsign, shape_id }]
  const [routeFilter, setRouteFilter] = useState(null); // { route_id, label } | null
  const [directionFilter, setDirectionFilter] = useState("all"); // "all" | "0" | "1"
  const [searchInput, setSearchInput] = useState("");
  const [searchDebounced, setSearchDebounced] = useState("");

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [renderedCount, setRenderedCount] = useState(VIRT_PAGE);

  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState(null);

  const listScrollRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Load trips on open ────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setTooLarge(false);
    setTrips([]);
    setSelectedIds(new Set());
    setRouteFilter(null);
    setDirectionFilter("all");
    setSearchInput("");
    setSearchDebounced("");

    (async () => {
      try {
        const res = await fetchWithSession(`${API_BASE_URL}/sql`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `SELECT trip_id, route_id, direction_id, trip_headsign, shape_id FROM trips ORDER BY route_id, direction_id, trip_id LIMIT ${TRIP_LOAD_LIMIT}`,
          }),
          signal: controller.signal,
        });
        const body = await res.json().catch(() => ({}));
        if (cancelled || !mountedRef.current) return;
        if (!res.ok) {
          setLoadError(body.error || `HTTP ${res.status}`);
          return;
        }
        const rows = Array.isArray(body.rows) ? body.rows : [];
        // If we hit exactly the cap, the feed may have more — surface a warning.
        if (rows.length >= TRIP_LOAD_LIMIT) {
          setTooLarge(true);
        }
        setTrips(rows);
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!mountedRef.current) return;
        setLoadError(err.message || "Network error");
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open]);

  // ── Search debounce (150ms) ───────────────────────────────────────────
  useEffect(() => {
    const id = setTimeout(() => setSearchDebounced(searchInput), 150);
    return () => clearTimeout(id);
  }, [searchInput]);

  // ── Route options (unique routes from loaded trips) ───────────────────
  const routeOptions = useMemo(() => {
    const map = new Map();
    for (const tr of trips) {
      if (tr.route_id == null) continue;
      if (!map.has(tr.route_id)) {
        map.set(tr.route_id, { route_id: tr.route_id, label: String(tr.route_id) });
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      String(a.route_id).localeCompare(String(b.route_id), undefined, {
        numeric: true,
      }),
    );
  }, [trips]);

  // ── Filtered trips ────────────────────────────────────────────────────
  const filteredTrips = useMemo(() => {
    const q = searchDebounced.trim().toLowerCase();
    return trips.filter((tr) => {
      if (routeFilter && String(tr.route_id) !== String(routeFilter.route_id)) {
        return false;
      }
      if (directionFilter !== "all") {
        if (String(tr.direction_id ?? "") !== directionFilter) return false;
      }
      if (q) {
        const id = String(tr.trip_id || "").toLowerCase();
        const head = String(tr.trip_headsign || "").toLowerCase();
        if (!id.includes(q) && !head.includes(q)) return false;
      }
      return true;
    });
  }, [trips, routeFilter, directionFilter, searchDebounced]);

  // Reset incremental window when filters change
  useEffect(() => {
    setRenderedCount(VIRT_PAGE);
    if (listScrollRef.current) listScrollRef.current.scrollTop = 0;
  }, [filteredTrips]);

  const visibleTrips = useMemo(
    () => filteredTrips.slice(0, renderedCount),
    [filteredTrips, renderedCount],
  );

  const handleListScroll = useCallback(() => {
    const el = listScrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      setRenderedCount((prev) =>
        Math.min(prev + VIRT_PAGE, filteredTrips.length),
      );
    }
  }, [filteredTrips.length]);

  // ── Selection helpers ─────────────────────────────────────────────────
  const toggleSelect = useCallback((tripId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(tripId)) next.delete(tripId);
      else next.add(tripId);
      return next;
    });
  }, []);

  // "Select all visible" semantics: only rows currently passing the filters,
  // and we exclude trips that are *already* linked to the same shape (no-op
  // mutation would spam the edit log).
  const selectableVisibleIds = useMemo(
    () =>
      filteredTrips
        .filter((tr) => tr.shape_id !== shapeId)
        .map((tr) => tr.trip_id),
    [filteredTrips, shapeId],
  );

  const allVisibleSelected = useMemo(() => {
    if (selectableVisibleIds.length === 0) return false;
    return selectableVisibleIds.every((id) => selectedIds.has(id));
  }, [selectableVisibleIds, selectedIds]);

  const someVisibleSelected = useMemo(
    () =>
      selectableVisibleIds.some((id) => selectedIds.has(id)) &&
      !allVisibleSelected,
    [selectableVisibleIds, selectedIds, allVisibleSelected],
  );

  const toggleSelectAllVisible = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of selectableVisibleIds) next.delete(id);
      } else {
        for (const id of selectableVisibleIds) next.add(id);
      }
      return next;
    });
  }, [allVisibleSelected, selectableVisibleIds]);

  // ── Preview counts ────────────────────────────────────────────────────
  const previewStats = useMemo(() => {
    let toLink = 0;
    let toReassign = 0;
    for (const tr of trips) {
      if (!selectedIds.has(tr.trip_id)) continue;
      if (tr.shape_id === shapeId) continue; // already linked — skipped
      toLink += 1;
      if (
        tr.shape_id != null &&
        tr.shape_id !== "" &&
        tr.shape_id !== shapeId
      ) {
        toReassign += 1;
      }
    }
    return { toLink, toReassign };
  }, [trips, selectedIds, shapeId]);

  const isLargeMutation = previewStats.toLink >= LARGE_MUTATION_THRESHOLD;

  // ── Apply ─────────────────────────────────────────────────────────────
  const handleApply = useCallback(async () => {
    if (applying) return;
    if (previewStats.toLink === 0) return;

    // Build the list of trip_ids actually mutated (skip already-linked).
    const ids = trips
      .filter(
        (tr) => selectedIds.has(tr.trip_id) && tr.shape_id !== shapeId,
      )
      .map((tr) => tr.trip_id);
    if (ids.length === 0) return;

    setApplying(true);
    setApplyError(null);
    try {
      const inList = ids.map(sqlQuoteString).join(", ");
      const sql = `UPDATE trips SET shape_id = ${sqlQuoteString(shapeId)} WHERE trip_id IN (${inList});`;

      const payload = { query: sql };
      if (isLargeMutation) {
        payload.confirmedLargeMutation = true;
      }

      const res = await fetchWithSession(`${API_BASE_URL}/edit/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!mountedRef.current) return;
      if (!res.ok) {
        setApplyError(body.error || `HTTP ${res.status}`);
        return;
      }

      const linked = ids.length;
      recordEdit(
        t("linkShapeToTrips.linkedToast", {
          count: linked,
          shapeId,
        }),
        body.validation,
        { entity: "shape", entityId: shapeId },
      );
      if (typeof onLinked === "function") onLinked(linked);
      onClose?.();
    } catch (err) {
      if (!mountedRef.current) return;
      setApplyError(err.message || "Network error");
    } finally {
      if (mountedRef.current) setApplying(false);
    }
  }, [
    applying,
    previewStats.toLink,
    trips,
    selectedIds,
    shapeId,
    isLargeMutation,
    recordEdit,
    t,
    onLinked,
    onClose,
  ]);

  const handleEnterEditMode = useCallback(() => {
    enterEditMode();
  }, [enterEditMode]);

  // ── Render ────────────────────────────────────────────────────────────
  const subtitleText = t("linkShapeToTrips.subtitle", {
    count: pointCount ?? 0,
    km: distanceKm ?? "0",
  });

  return (
    <Dialog
      open={open}
      onClose={applying ? undefined : onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{ sx: { height: "min(720px, 90vh)" } }}
    >
      <DialogTitle sx={{ pb: 1 }}>
        <Box display="flex" alignItems="center" gap={1}>
          <LinkIcon fontSize="small" color="primary" />
          <Typography variant="h6" component="span" fontWeight={700}>
            {t("linkShapeToTrips.title")}
          </Typography>
        </Box>
        <Box display="flex" alignItems="center" gap={1} mt={0.5}>
          <Chip
            label={shapeId}
            size="small"
            sx={{ fontFamily: "monospace", fontSize: 11 }}
          />
          <Typography variant="caption" color="text.secondary">
            {subtitleText}
          </Typography>
        </Box>
      </DialogTitle>

      <DialogContent dividers sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
        {/* Edit mode required */}
        {!editing && (
          <Alert
            severity="warning"
            action={
              <Button
                color="inherit"
                size="small"
                onClick={handleEnterEditMode}
                variant="outlined"
              >
                {t("linkShapeToTrips.enterEditMode")}
              </Button>
            }
          >
            {t("linkShapeToTrips.needsEditMode")}
          </Alert>
        )}

        {loadError && (
          <Alert severity="error">
            {loadError}
          </Alert>
        )}

        {tooLarge && (
          <Alert severity="info">
            {t("linkShapeToTrips.tooLarge")}
          </Alert>
        )}

        {/* Filters */}
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1.25}
          alignItems={{ xs: "stretch", sm: "center" }}
        >
          <Autocomplete
            size="small"
            sx={{ minWidth: 200, flex: 1 }}
            options={routeOptions}
            value={routeFilter}
            onChange={(_, val) => setRouteFilter(val)}
            getOptionLabel={(opt) => opt?.label || ""}
            isOptionEqualToValue={(a, b) =>
              String(a?.route_id) === String(b?.route_id)
            }
            renderInput={(params) => (
              <TextField
                {...params}
                label={t("linkShapeToTrips.filterRoute")}
              />
            )}
          />

          <ToggleButtonGroup
            size="small"
            exclusive
            value={directionFilter}
            onChange={(_, val) => {
              if (val !== null) setDirectionFilter(val);
            }}
            aria-label={t("linkShapeToTrips.filterDirection")}
          >
            <ToggleButton value="all">All</ToggleButton>
            <ToggleButton value="0">0</ToggleButton>
            <ToggleButton value="1">1</ToggleButton>
          </ToggleButtonGroup>

          <TextField
            size="small"
            sx={{ minWidth: 200, flex: 1.2 }}
            placeholder={t("linkShapeToTrips.filterSearch")}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </Stack>

        <Divider />

        {/* Select all */}
        <Box display="flex" alignItems="center" gap={1}>
          <Checkbox
            size="small"
            checked={allVisibleSelected}
            indeterminate={someVisibleSelected}
            disabled={selectableVisibleIds.length === 0}
            onChange={toggleSelectAllVisible}
          />
          <Typography variant="body2" color="text.secondary">
            {t("linkShapeToTrips.selectAllVisible", {
              visible: filteredTrips.length,
              total: trips.length,
            })}
          </Typography>
        </Box>

        <Divider />

        {/* List */}
        <Box
          ref={listScrollRef}
          onScroll={handleListScroll}
          sx={{
            flex: 1,
            minHeight: 240,
            maxHeight: 360,
            overflowY: "auto",
            border: `1px solid ${theme.palette.divider}`,
            borderRadius: 1,
            background: alpha(theme.palette.background.default, 0.5),
          }}
        >
          {loading ? (
            <Box display="flex" alignItems="center" justifyContent="center" py={6}>
              <CircularProgress size={24} />
            </Box>
          ) : visibleTrips.length === 0 ? (
            <Box display="flex" alignItems="center" justifyContent="center" py={6}>
              <Typography variant="body2" color="text.secondary">
                —
              </Typography>
            </Box>
          ) : (
            visibleTrips.map((tr) => {
              const checked = selectedIds.has(tr.trip_id);
              const alreadyLinked = tr.shape_id === shapeId;
              const willReassign =
                !alreadyLinked &&
                tr.shape_id != null &&
                tr.shape_id !== "";
              return (
                <Box
                  key={tr.trip_id}
                  onClick={() => {
                    if (alreadyLinked) return;
                    toggleSelect(tr.trip_id);
                  }}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    px: 1.25,
                    py: 0.5,
                    cursor: alreadyLinked ? "not-allowed" : "pointer",
                    opacity: alreadyLinked ? 0.55 : 1,
                    borderBottom: `1px solid ${alpha(
                      theme.palette.divider,
                      0.5,
                    )}`,
                    "&:hover": alreadyLinked
                      ? {}
                      : {
                          background: alpha(theme.palette.primary.main, 0.06),
                        },
                  }}
                >
                  <Checkbox
                    size="small"
                    checked={checked}
                    disabled={alreadyLinked}
                    onChange={(e) => {
                      e.stopPropagation();
                      if (!alreadyLinked) toggleSelect(tr.trip_id);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography
                      sx={{
                        fontFamily: "monospace",
                        fontSize: 12,
                        fontWeight: 600,
                        color: "text.primary",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {tr.trip_id}
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{
                        fontSize: 11,
                        color: "text.secondary",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        display: "block",
                      }}
                    >
                      {`route ${tr.route_id ?? "—"} · dir ${
                        tr.direction_id ?? "—"
                      }${
                        tr.trip_headsign ? ` · ${tr.trip_headsign}` : ""
                      }`}
                    </Typography>
                  </Box>
                  {alreadyLinked && (
                    <Chip
                      label={t("linkShapeToTrips.alreadyLinked")}
                      size="small"
                      color="success"
                      variant="outlined"
                      sx={{ fontSize: 10, height: 20 }}
                    />
                  )}
                  {willReassign && (
                    <Chip
                      label={`${tr.shape_id} → ${t("linkShapeToTrips.willReassign")}`}
                      size="small"
                      color="warning"
                      variant="outlined"
                      sx={{ fontSize: 10, height: 20, maxWidth: 220 }}
                      title={`${tr.shape_id} ${t("linkShapeToTrips.willReassign")}`}
                    />
                  )}
                </Box>
              );
            })
          )}
        </Box>

        {/* Preview */}
        <Box
          sx={{
            borderRadius: 1,
            background: alpha(theme.palette.primary.main, 0.06),
            border: `1px solid ${alpha(theme.palette.primary.main, 0.2)}`,
            p: 1.25,
          }}
        >
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {t("linkShapeToTrips.previewLine1", {
              count: previewStats.toLink,
            })}
          </Typography>
          {previewStats.toReassign > 0 && (
            <Typography
              variant="caption"
              sx={{ color: "warning.main", display: "block", mt: 0.25 }}
            >
              {t("linkShapeToTrips.previewReassign", {
                count: previewStats.toReassign,
              })}
            </Typography>
          )}
        </Box>

        {isLargeMutation && (
          <Alert severity="warning">
            <AlertTitle>{`${previewStats.toLink} trips`}</AlertTitle>
            {`This will affect ${previewStats.toLink}+ trips. Click "${t(
              "linkShapeToTrips.applyButton",
              { count: previewStats.toLink },
            )}" to confirm.`}
          </Alert>
        )}

        {applyError && <Alert severity="error">{applyError}</Alert>}
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose} disabled={applying}>
          {t("linkShapeToTrips.cancel")}
        </Button>
        <Button
          variant="contained"
          color="primary"
          onClick={handleApply}
          disabled={
            applying ||
            !editing ||
            previewStats.toLink === 0 ||
            loading
          }
          startIcon={
            applying ? (
              <CircularProgress size={16} color="inherit" />
            ) : (
              <LinkIcon fontSize="small" />
            )
          }
        >
          {t("linkShapeToTrips.applyButton", {
            count: previewStats.toLink,
          })}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default LinkShapeToTripsDialog;
