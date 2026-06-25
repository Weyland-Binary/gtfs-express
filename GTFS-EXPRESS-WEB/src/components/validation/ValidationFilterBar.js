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

const MONOSPACE = '"JetBrains Mono", "Fira Code", monospace';

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
          height: 34,
          borderRadius: 5,
          border: `1px solid ${
            searchQuery
              ? alpha(theme.palette.primary.main, 0.5)
              : theme.palette.divider
          }`,
          bgcolor: "background.paper",
          transition: "border-color 0.15s",
          minWidth: 220,
          flexShrink: 0,
          "&:focus-within": { borderColor: theme.palette.primary.main },
        }}
      >
        <SearchIcon sx={{ fontSize: 16, color: "text.disabled", flexShrink: 0 }} />
        <InputBase
          inputRef={searchInputRef}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t("validation.filter.search.placeholder")}
          sx={{ flex: 1, fontSize: "0.8rem", "& input": { py: 0, px: 0.5 } }}
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
        <Box display="flex" alignItems="center" gap={0.5} flexWrap="wrap">
          <Chip
            size="small"
            label={t("validation.filter.file.all")}
            onClick={() => onToggleFile(null, false)}
            sx={{
              height: 26,
              fontSize: "0.72rem",
              fontWeight: 600,
              cursor: "pointer",
              bgcolor: allSelected
                ? alpha(theme.palette.primary.main, isDark ? 0.18 : 0.08)
                : "background.paper",
              color: allSelected ? theme.palette.primary.main : "text.secondary",
              border: `1px solid ${
                allSelected
                  ? alpha(theme.palette.primary.main, 0.4)
                  : theme.palette.divider
              }`,
            }}
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
                  label={`${fileName} · ${count}`}
                  onClick={(e) => handleFileChipClick(fileName, e)}
                  sx={{
                    height: 26,
                    fontSize: "0.7rem",
                    fontWeight: isSelected ? 700 : 500,
                    cursor: "pointer",
                    fontFamily: MONOSPACE,
                    bgcolor: isSelected
                      ? alpha(theme.palette.primary.main, isDark ? 0.18 : 0.08)
                      : "background.paper",
                    color: isSelected
                      ? theme.palette.primary.main
                      : "text.secondary",
                    border: `1px solid ${
                      isSelected
                        ? alpha(theme.palette.primary.main, 0.4)
                        : theme.palette.divider
                    }`,
                    "&:hover": {
                      borderColor: alpha(theme.palette.primary.main, 0.35),
                    },
                  }}
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
