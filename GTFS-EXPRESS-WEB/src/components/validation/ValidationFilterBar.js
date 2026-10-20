import React from "react";
import {
  Box,
  Chip,
  InputBase,
  Tooltip,
  IconButton,
  useTheme,
  alpha,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import ClearIcon from "@mui/icons-material/Clear";
import { useLanguage } from "../../contexts/LanguageContext";


/**
 * One light row: free-text search + per-file filter chips.
 * - Alt+click on a file chip = solo (deselect all others).
 * - Empty fileFilter set means "all files".
 */
function ValidationFilterBar({
  fileCounts,
  fileFilter,
  onToggleFile,
  searchQuery,
  onSearchChange,
  searchInputRef,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { t } = useLanguage();

  const fileNames = Object.keys(fileCounts).sort();
  // A chip: neutral; chosen, in the primary colour on its light tint.
  const chipSx = (selected) => ({
    height: 28,
    borderRadius: "8px",
    fontSize: "0.78rem",
    fontWeight: selected ? 600 : 500,
    cursor: "pointer",
    color: selected ? theme.palette.primary.main : "text.secondary",
    bgcolor: selected ? alpha(theme.palette.primary.main, isDark ? 0.18 : 0.08) : "transparent",
    border: `1px solid ${selected ? alpha(theme.palette.primary.main, 0.35) : theme.palette.divider}`,
    transition: "background-color 150ms, border-color 150ms",
    "&:hover": { bgcolor: theme.palette.action.hover },
  });
  const allSelected = fileFilter.size === 0;

  const handleFileChipClick = (fileName, e) => {
    onToggleFile(fileName, Boolean(e.altKey));
  };

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        flexWrap: "wrap",
      }}
    >
      {/* Search box */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          px: 1.25,
          height: 32,
          borderRadius: "8px",
          border: `1px solid ${
            searchQuery
              ? alpha(theme.palette.text.primary, 0.3)
              : theme.palette.divider
          }`,
          bgcolor: "background.paper",
          transition: "border-color 0.15s",
          minWidth: 220,
          flexShrink: 0,
          "&:focus-within": { borderColor: theme.palette.primary.main, boxShadow: `0 0 0 3px ${alpha(theme.palette.primary.main, 0.12)}` },
        }}
      >
        <SearchIcon sx={{ fontSize: 16, color: "text.disabled", flexShrink: 0 }} />
        <InputBase
          inputRef={searchInputRef}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t("validation.filter.search.placeholder")}
          sx={{ flex: 1, fontSize: "0.82rem", "& input": { py: 0, px: 0.5 } }}
        />
        {searchQuery && (
          <IconButton
            size="small"
            onClick={() => onSearchChange("")}
            sx={{ p: 0.25, color: "text.disabled" }}
          >
            <ClearIcon sx={{ fontSize: 13 }} />
          </IconButton>
        )}
      </Box>

      {/* File chips — only when there is more than one file to choose from */}
      {fileNames.length > 1 && (
        <Box display="flex" alignItems="center" gap={0.75} flexWrap="wrap">
          <Chip
            size="small"
            label={t("validation.filter.file.all")}
            onClick={() => onToggleFile(null, false)}
            sx={chipSx(allSelected)}
          />
          {fileNames.map((fileName) => {
            const isSelected = !allSelected && fileFilter.has(fileName);
            const count = fileCounts[fileName] ?? 0;
            return (
              <Tooltip
                key={fileName}
                title={t("validation.filter.file.soloHint", { count })}
                arrow
              >
                <Chip
                  size="small"
                  label={
                    <>
                      {fileName}
                      <Box component="span" sx={{ ml: 0.75, color: "text.secondary", fontWeight: 400, fontVariantNumeric: "tabular-nums" }}>
                        {count.toLocaleString()}
                      </Box>
                    </>
                  }
                  onClick={(e) => handleFileChipClick(fileName, e)}
                  sx={chipSx(isSelected)}
                />
              </Tooltip>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

export default ValidationFilterBar;
