import React from "react";
import {
  Box,
  Button,
  Typography,
  IconButton,
  Tooltip,
  Chip,
  TextField,
  Divider,
  Popover,
  InputAdornment,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import StarIcon from "@mui/icons-material/Star";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import SearchIcon from "@mui/icons-material/Search";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import { MONO_FONT } from "./constants";
import {
  BROWSE_FILES,
  BROWSE_GROUPS,
  PRESET_QUERIES,
  GROUP_ICONS,
} from "./presetQueries";
import { formatHumanCount } from "./formatters";

/**
 * BrowseStrip — the « browse files » row above the editor: one chip per GTFS
 * table with its row count (disabled when the feed has none, lit when the
 * editor holds its `SELECT * FROM table;`), the Schedule group always shown
 * and an extension group only once the feed has a row in one of its tables,
 * and the query library's button at the right with the count of saved presets.
 */
export function BrowseStrip({
  counts,
  activeBrowseTable,
  browseFile,
  userPresets,
  presetLibraryAnchor,
  setPresetLibraryAnchor,
  setActivePresetGroup,
  t,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  /* --- render helpers -------------------------------------------- */
  // Browse chip strip: pill shape, hover lift, glow on active,
  // monospace count badge inside the chip.
  const renderBrowseChips = (files = BROWSE_FILES) => {
    return files.map((f) => {
      const count = counts?.[f.table] ?? 0;
      const present = count > 0;
      const isActive = activeBrowseTable === f.table;
      const dotColor = present
        ? theme.palette.success.main
        : alpha(theme.palette.text.disabled, 0.5);
      return (
        <Box
          key={f.table}
          component="button"
          type="button"
          className={`sql-browse-chip${
            !present ? " sql-browse-chip--disabled" : ""
          }`}
          disabled={!present}
          onClick={present ? () => browseFile(f.table) : undefined}
          sx={{
            display: "inline-flex",
            alignItems: "center",
            gap: 0.5,
            height: 24,
            px: 1,
            borderRadius: 999,
            border: `1px solid ${
              isActive ? "transparent" : alpha(theme.palette.text.primary, 0.12)
            }`,
            background: isActive
              ? theme.palette.primary.main
              : alpha(theme.palette.background.paper, 0.6),
            color: isActive
              ? theme.palette.primary.contrastText
              : present
                ? theme.palette.text.primary
                : theme.palette.text.disabled,
            cursor: present ? "pointer" : "not-allowed",
            opacity: present ? 1 : 0.5,
            fontFamily: MONO_FONT,
            fontSize: 11.5,
            fontWeight: 600,
            outline: "none",
            boxShadow: isActive
              ? `0 0 0 1px ${alpha(theme.palette.primary.main, 0.3)}, 0 1px 3px ${alpha(
                  theme.palette.primary.main,
                  0.25,
                )}`
              : "none",
            "&:hover:not(:disabled)": {
              background: isActive
                ? theme.palette.primary.main
                : alpha(theme.palette.text.primary, 0.04),
              boxShadow: isActive
                ? `0 0 0 1px ${alpha(theme.palette.primary.main, 0.4)}, 0 2px 6px ${alpha(
                    theme.palette.primary.main,
                    0.3,
                  )}`
                : `0 1px 3px ${alpha(theme.palette.text.primary, 0.08)}`,
            },
            "&:focus-visible": {
              outline: `2px solid ${theme.palette.primary.main}`,
              outlineOffset: 2,
            },
          }}
        >
          <Box
            component="span"
            sx={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: isActive
                ? alpha(theme.palette.primary.contrastText, 0.85)
                : dotColor,
              flexShrink: 0,
            }}
          />
          <span style={{ fontWeight: 700 }}>{f.table}</span>
          <span
            style={{
              fontSize: 10,
              opacity: isActive ? 0.85 : 0.6,
              fontWeight: 600,
            }}
          >
            {formatHumanCount(count)}
          </span>
        </Box>
      );
    });
  };

  return (
    <>
      {/* ---------- Browse files / Query library strip ----------
        Compact row with two related affordances side-by-side: 1-click
        chips per GTFS table (left) and the saved/built-in preset library
        (right). Sits on the surfaceAlt background to read as a single
        "browse" zone, separated from the editor below by a divider. */}
      <Box
        sx={{
          px: 2,
          pt: 1,
          pb: 0.75,
          background: alpha(
            theme.palette.text.primary,
            isDark ? 0.025 : 0.015,
          ),
          borderBottom: `1px solid ${theme.palette.divider}`,
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1.25,
            mb: 0.5,
          }}
        >
          <Typography
            variant="caption"
            sx={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: theme.palette.text.disabled,
            }}
          >
            {t("sqlConsole.browseFiles")}
          </Typography>
          <Box flex={1} />
          <Button
            size="small"
            startIcon={<MenuBookIcon sx={{ fontSize: "14px !important" }} />}
            endIcon={
              <ArrowDropDownIcon sx={{ fontSize: "16px !important" }} />
            }
            onClick={(e) => {
              setPresetLibraryAnchor(e.currentTarget);
              setActivePresetGroup(PRESET_QUERIES[0].groupId);
            }}
            aria-haspopup="true"
            aria-expanded={Boolean(presetLibraryAnchor)}
            sx={{
              fontSize: 11,
              height: 24,
              textTransform: "none",
              px: 1,
              color: theme.palette.text.secondary,
              border: `1px solid ${alpha(theme.palette.text.primary, 0.12)}`,
              borderRadius: 1,
              gap: 0,
              "&:hover": {
                background: alpha(theme.palette.text.primary, 0.04),
                borderColor: alpha(theme.palette.text.primary, 0.22),
              },
            }}
          >
            {t("sqlConsole.presetLibrary")}
            {userPresets.length > 0 && (
              <Box
                component="span"
                sx={{
                  ml: 0.75,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minWidth: 16,
                  height: 16,
                  px: 0.5,
                  borderRadius: "8px",
                  background: theme.palette.warning.main,
                  color: theme.palette.warning.contrastText,
                  fontSize: 9,
                  fontWeight: 700,
                  lineHeight: 1,
                }}
              >
                {userPresets.length}
              </Box>
            )}
          </Button>
        </Box>
        {(() => {
          const visibleGroupCount = BROWSE_GROUPS.filter(
            (g, i) =>
              i === 0 || g.files.some((f) => (counts?.[f.table] ?? 0) > 0),
          ).length;
          return BROWSE_GROUPS.map((group, idx) => {
            // Always show the Schedule group. Extension groups stay hidden
            // until the session DB has at least one row in any of their
            // tables — keeps the strip uncluttered for plain Schedule feeds.
            const groupHasData = group.files.some(
              (f) => (counts?.[f.table] ?? 0) > 0,
            );
            if (idx > 0 && !groupHasData) return null;
            return (
              <Box
                key={group.id}
                sx={{
                  mt: idx === 0 ? 0 : 0.75,
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 1,
                }}
              >
                {visibleGroupCount > 1 && (
                  <Typography
                    variant="caption"
                    sx={{
                      flexShrink: 0,
                      minWidth: 56,
                      pt: "4px",
                      fontSize: 9.5,
                      fontWeight: 700,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: theme.palette.text.disabled,
                    }}
                  >
                    {t(group.labelKey)}
                  </Typography>
                )}
                <Box
                  sx={{
                    flex: 1,
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "6px",
                  }}
                >
                  {renderBrowseChips(group.files)}
                </Box>
              </Box>
            );
          });
        })()}
      </Box>
    </>
  );
}

/**
 * PresetLibrary — the query library popover: the built-in groups in a left
 * rail with their counts (and « saved » when the person has presets), the
 * group's queries on the right, or a flat search across every group. A
 * click puts the query in the editor without running it.
 */
export default function PresetLibrary({
  presetLibraryAnchor,
  setPresetLibraryAnchor,
  presetSearch,
  setPresetSearch,
  presetGroups,
  activePresetGroup,
  setActivePresetGroup,
  userPresets,
  insertPreset,
  handleDeleteUserPreset,
  t,
}) {
  const theme = useTheme();
  return (
    <>
      {/* ================================================================
        Preset Library — rich two-column Popover
        ╔══════════════════════════════════════════════════════╗
        ║  🔖 Query Library          [ 🔍 search…          ]  ║
        ╠══════════════╦═══════════════════════════════════════╣
        ║ ▌ Network  7 ║  Route · trip count                   ║
        ║   Quality 12 ║    SELECT r.route_id …   (on hover)   ║
        ║   Topology 4 ║  Routes per agency                    ║
        ║  ★ Saved   2 ║  …                                    ║
        ╚══════════════╩═══════════════════════════════════════╝
       ================================================================ */}
      <Popover
        open={Boolean(presetLibraryAnchor)}
        anchorEl={presetLibraryAnchor}
        onClose={() => {
          setPresetLibraryAnchor(null);
          setPresetSearch("");
        }}
        anchorOrigin={{ horizontal: "left", vertical: "bottom" }}
        transformOrigin={{ horizontal: "left", vertical: "top" }}
        PaperProps={{
          elevation: 6,
          sx: {
            width: 560,
            height: 440,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            mt: 0.5,
            border: `1px solid ${theme.palette.divider}`,
            borderRadius: 1.5,
          },
        }}
      >
        {/* ── Header ─────────────────────────────────────────────── */}
        <Box
          sx={{
            px: 2,
            py: 0.75,
            display: "flex",
            alignItems: "center",
            gap: 1,
            borderBottom: `1px solid ${theme.palette.divider}`,
            flexShrink: 0,
            background: alpha(theme.palette.text.primary, 0.02),
          }}
        >
          <MenuBookIcon
            sx={{ fontSize: 14, color: theme.palette.text.secondary }}
          />
          <Typography
            variant="caption"
            sx={{
              fontWeight: 700,
              letterSpacing: "0.07em",
              textTransform: "uppercase",
              fontSize: 10,
              color: theme.palette.text.secondary,
            }}
          >
            {t("sqlConsole.presetLibrary")}
          </Typography>
          <Box flex={1} />
          <TextField
            size="small"
            placeholder={t("sqlConsole.presetSearch")}
            value={presetSearch}
            onChange={(e) => setPresetSearch(e.target.value)}
            autoComplete="off"
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon
                      sx={{
                        fontSize: 13,
                        color: theme.palette.text.disabled,
                      }}
                    />
                  </InputAdornment>
                ),
              },
            }}
            sx={{
              width: 175,
              "& .MuiInputBase-input": { fontSize: 11.5, py: "3.5px" },
              "& .MuiOutlinedInput-root": { height: 26, borderRadius: 1 },
            }}
          />
        </Box>

        {/* ── Body ────────────────────────────────────────────────── */}
        {presetSearch.trim() ? (
          /* ── Flat search results (all groups) ── */
          <Box sx={{ flex: 1, overflowY: "auto", py: 0.5 }}>
            {(() => {
              const q = presetSearch.trim().toLowerCase();
              const hits = presetGroups.flatMap((g) =>
                g.items
                  .filter((p) => t(p.labelKey).toLowerCase().includes(q))
                  .map((p) => ({ ...p, groupLabelKey: g.groupLabelKey })),
              );
              if (hits.length === 0)
                return (
                  <Typography
                    variant="caption"
                    sx={{
                      px: 2.5,
                      py: 1.5,
                      display: "block",
                      color: theme.palette.text.disabled,
                    }}
                  >
                    {t("sqlConsole.schema.empty")}
                  </Typography>
                );
              return hits.map((p) => (
                <Box
                  key={p.id}
                  onClick={() => {
                    insertPreset(p.sql, false);
                    setPresetLibraryAnchor(null);
                    setPresetSearch("");
                  }}
                  sx={{
                    px: 2.5,
                    py: 0.7,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 1.5,
                    "&:hover": {
                      background: alpha(theme.palette.primary.main, 0.06),
                    },
                  }}
                >
                  <Box flex={1} sx={{ minWidth: 0 }}>
                    <Typography
                      variant="body2"
                      sx={{ fontSize: 12.5, lineHeight: 1.3 }}
                    >
                      {t(p.labelKey)}
                    </Typography>
                  </Box>
                  <Chip
                    label={t(p.groupLabelKey)}
                    size="small"
                    sx={{
                      height: 16,
                      fontSize: 9,
                      flexShrink: 0,
                      mt: 0.3,
                      "& .MuiChip-label": { px: 0.75 },
                    }}
                  />
                </Box>
              ));
            })()}
          </Box>
        ) : (
          /* ── Two-column layout ── */
          <Box sx={{ flex: 1, display: "flex", minHeight: 0 }}>
            {/* Left rail — group tabs */}
            <Box
              sx={{
                width: 152,
                flexShrink: 0,
                borderRight: `1px solid ${theme.palette.divider}`,
                overflowY: "auto",
                py: 0.5,
                background: alpha(theme.palette.text.primary, 0.015),
              }}
            >
              {presetGroups.map((group) => {
                const GroupIcon = GROUP_ICONS[group.groupId];
                const isActive = activePresetGroup === group.groupId;
                return (
                  <Box
                    key={group.groupId}
                    onClick={() => setActivePresetGroup(group.groupId)}
                    sx={{
                      px: 1.5,
                      py: 0.8,
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      cursor: "pointer",
                      borderLeft: isActive
                        ? `3px solid ${theme.palette.primary.main}`
                        : "3px solid transparent",
                      background: isActive
                        ? alpha(theme.palette.primary.main, 0.09)
                        : "transparent",
                      transition: "background 120ms, border-color 120ms",
                      "&:hover": {
                        background: isActive
                          ? alpha(theme.palette.primary.main, 0.12)
                          : alpha(theme.palette.text.primary, 0.05),
                      },
                    }}
                  >
                    {GroupIcon && (
                      <GroupIcon
                        sx={{
                          fontSize: 14,
                          color: isActive
                            ? theme.palette.primary.main
                            : theme.palette.text.secondary,
                          flexShrink: 0,
                          transition: "color 120ms",
                        }}
                      />
                    )}
                    <Typography
                      variant="caption"
                      sx={{
                        flex: 1,
                        fontSize: 11.5,
                        fontWeight: isActive ? 700 : 400,
                        color: isActive
                          ? theme.palette.primary.main
                          : theme.palette.text.primary,
                        transition: "color 120ms",
                        lineHeight: 1.2,
                      }}
                    >
                      {t(group.groupLabelKey)}
                    </Typography>
                    <Box
                      sx={{
                        minWidth: 18,
                        height: 16,
                        px: 0.5,
                        borderRadius: 0.75,
                        background: isActive
                          ? alpha(theme.palette.primary.main, 0.15)
                          : alpha(theme.palette.text.primary, 0.07),
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 9,
                        fontWeight: 700,
                        color: isActive
                          ? theme.palette.primary.main
                          : theme.palette.text.disabled,
                        flexShrink: 0,
                        transition: "background 120ms, color 120ms",
                      }}
                    >
                      {group.items.length}
                    </Box>
                  </Box>
                );
              })}
              {userPresets.length > 0 && (
                <>
                  <Divider sx={{ my: 0.5 }} />
                  <Box
                    onClick={() => setActivePresetGroup("saved")}
                    sx={{
                      px: 1.5,
                      py: 0.8,
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      cursor: "pointer",
                      borderLeft:
                        activePresetGroup === "saved"
                          ? `3px solid ${theme.palette.warning.main}`
                          : "3px solid transparent",
                      background:
                        activePresetGroup === "saved"
                          ? alpha(theme.palette.warning.main, 0.09)
                          : "transparent",
                      transition: "background 120ms",
                      "&:hover": {
                        background:
                          activePresetGroup === "saved"
                            ? alpha(theme.palette.warning.main, 0.13)
                            : alpha(theme.palette.text.primary, 0.05),
                      },
                    }}
                  >
                    <StarIcon
                      sx={{
                        fontSize: 14,
                        color:
                          activePresetGroup === "saved"
                            ? theme.palette.warning.main
                            : theme.palette.text.secondary,
                        flexShrink: 0,
                        transition: "color 120ms",
                      }}
                    />
                    <Typography
                      variant="caption"
                      sx={{
                        flex: 1,
                        fontSize: 11.5,
                        fontWeight: activePresetGroup === "saved" ? 700 : 400,
                        color:
                          activePresetGroup === "saved"
                            ? theme.palette.warning.main
                            : theme.palette.text.primary,
                        transition: "color 120ms",
                        lineHeight: 1.2,
                      }}
                    >
                      {t("sqlConsole.userPresets")}
                    </Typography>
                    <Box
                      sx={{
                        minWidth: 18,
                        height: 16,
                        px: 0.5,
                        borderRadius: 0.75,
                        background: alpha(
                          theme.palette.warning.main,
                          activePresetGroup === "saved" ? 0.18 : 0.1,
                        ),
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 9,
                        fontWeight: 700,
                        color: theme.palette.warning.main,
                        flexShrink: 0,
                      }}
                    >
                      {userPresets.length}
                    </Box>
                  </Box>
                </>
              )}
            </Box>

            {/* Right panel — items */}
            <Box sx={{ flex: 1, overflowY: "auto", py: 0.5, minWidth: 0 }}>
              {activePresetGroup === "saved"
                ? userPresets.map((p) => (
                    <Box
                      key={p.id}
                      sx={{
                        px: 2.5,
                        py: 0.7,
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 0.5,
                        "&:hover": {
                          background: alpha(theme.palette.warning.main, 0.06),
                        },
                      }}
                    >
                      <Box
                        flex={1}
                        sx={{ cursor: "pointer", minWidth: 0 }}
                        onClick={() => {
                          insertPreset(p.sql, false);
                          setPresetLibraryAnchor(null);
                          setPresetSearch("");
                        }}
                      >
                        <Typography
                          variant="body2"
                          sx={{
                            fontSize: 12.5,
                            lineHeight: 1.3,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {p.name}
                        </Typography>
                      </Box>
                      <Tooltip
                        title={t("sqlConsole.presetDeleteTooltip")}
                        arrow
                      >
                        <IconButton
                          size="small"
                          onClick={() => handleDeleteUserPreset(p.id)}
                          aria-label={t("sqlConsole.presetDeleteTooltip")}
                          sx={{
                            width: 22,
                            height: 22,
                            flexShrink: 0,
                            mt: 0.1,
                          }}
                        >
                          <DeleteOutlineIcon sx={{ fontSize: 13 }} />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  ))
                : (
                    presetGroups.find((g) => g.groupId === activePresetGroup)
                      ?.items ?? []
                  ).map((p) => (
                    <Box
                      key={p.id}
                      onClick={() => {
                        insertPreset(p.sql, false);
                        setPresetLibraryAnchor(null);
                        setPresetSearch("");
                      }}
                      sx={{
                        px: 2.5,
                        py: 0.7,
                        cursor: "pointer",
                        "&:hover": {
                          background: alpha(theme.palette.primary.main, 0.06),
                        },
                      }}
                    >
                      <Typography
                        variant="body2"
                        sx={{ fontSize: 12.5, lineHeight: 1.3 }}
                      >
                        {t(p.labelKey)}
                      </Typography>
                    </Box>
                  ))}
            </Box>
          </Box>
        )}
      </Popover>
    </>
  );
}
