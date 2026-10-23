import React from "react";
import {
  Box,
  Button,
  Typography,
  IconButton,
  Tooltip,
  LinearProgress,
  TextField,
  Collapse,
  List,
  ListItemButton,
  ListItemText,
  InputAdornment,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import SchemaIcon from "@mui/icons-material/Schema";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ClearIcon from "@mui/icons-material/Clear";
import SearchIcon from "@mui/icons-material/Search";
import { MONO_FONT, SCHEMA_WIDTH_MIN, SCHEMA_WIDTH_MAX } from "./constants";
import { TYPE_TO_COLOR } from "./sqlText";
import { formatRowCount } from "./formatters";

/** The schema explorer at the left of the results; its state is useSchema's. */
export default function SchemaSidebar({
  schemaVisible,
  schemaWidth,
  schemaTables,
  filteredSchemaTables,
  schemaLoading,
  schemaSearch,
  setSchemaSearch,
  expandedTables,
  setExpandedTables,
  setSchemaVisible,
  handleSchemaSplitterMouseDown,
  counts,
  browseFile,
  insertAtCursor,
  showSnack,
  t,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  return (
    <>
      {schemaVisible && (
        <>
          <Box
            className="schema-sidebar"
            sx={{
              width: schemaWidth,
              minWidth: SCHEMA_WIDTH_MIN,
              maxWidth: SCHEMA_WIDTH_MAX,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              background: alpha(
                theme.palette.text.primary,
                isDark ? 0.025 : 0.015,
              ),
              borderRight: `1px solid ${theme.palette.divider}`,
              overflow: "hidden",
              animation: "sqlSlideInLeft 200ms ease-out",
            }}
          >
            {/* 36px to align with the top status bar. */}
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.75,
                px: 1.25,
                height: 36,
                borderBottom: `1px solid ${theme.palette.divider}`,
                background: alpha(
                  theme.palette.text.primary,
                  isDark ? 0.04 : 0.025,
                ),
                flexShrink: 0,
              }}
            >
              <SchemaIcon
                sx={{
                  fontSize: 14,
                  color: theme.palette.primary.main,
                }}
              />
              <Typography
                variant="caption"
                sx={{
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  fontWeight: 700,
                  fontSize: 10,
                  color: theme.palette.text.primary,
                }}
              >
                {t("sqlConsole.schema")}
              </Typography>
              {schemaTables.length > 0 && (
                <Typography
                  variant="caption"
                  sx={{
                    fontSize: 10,
                    fontFamily: MONO_FONT,
                    fontVariantNumeric: "tabular-nums",
                    color: theme.palette.text.disabled,
                    fontWeight: 600,
                  }}
                >
                  {t("sqlConsole.schema.tablesCount", {
                    count: schemaTables.length,
                  })}
                </Typography>
              )}
              {schemaLoading && (
                <LinearProgress
                  sx={{
                    flex: 1,
                    ml: 0.5,
                    maxWidth: 60,
                    height: 2,
                  }}
                />
              )}
              <Box flex={1} />
              <Tooltip title={t("sqlConsole.schema.close")} arrow>
                <IconButton
                  size="small"
                  onClick={() => setSchemaVisible(false)}
                  aria-label={t("sqlConsole.schema.close")}
                  sx={{
                    width: 22,
                    height: 22,
                    color: theme.palette.text.secondary,
                  }}
                >
                  <ClearIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            </Box>

            <Box
              sx={{
                px: 1,
                py: 0.75,
                borderBottom: `1px solid ${theme.palette.divider}`,
                flexShrink: 0,
              }}
            >
              <Tooltip
                title={t("sqlConsole.schemaClickColumn")}
                placement="bottom-start"
                arrow
              >
                <TextField
                  size="small"
                  fullWidth
                  value={schemaSearch}
                  onChange={(e) => setSchemaSearch(e.target.value)}
                  placeholder={t("sqlConsole.schema.search")}
                  slotProps={{
                    input: {
                      startAdornment: (
                        <InputAdornment position="start">
                          <SearchIcon
                            fontSize="small"
                            sx={{
                              color: theme.palette.text.secondary,
                              fontSize: 14,
                            }}
                          />
                        </InputAdornment>
                      ),
                    },
                    htmlInput: {
                      style: { fontSize: 12, padding: "4px 6px" },
                      "aria-label": t("sqlConsole.schema.search"),
                    },
                  }}
                />
              </Tooltip>
            </Box>

            <Box sx={{ flex: 1, overflow: "auto", minHeight: 0 }}>
              {schemaLoading && schemaTables.length === 0 && (
                <Box sx={{ px: 1.25, pt: 0.5 }}>
                  {[0, 1, 2, 3, 4].map((i) => (
                    <Box
                      key={i}
                      sx={{
                        height: 18,
                        mb: 0.5,
                        borderRadius: 0.5,
                        background: `linear-gradient(90deg, ${alpha(
                          theme.palette.text.primary,
                          0.04,
                        )} 0%, ${alpha(
                          theme.palette.text.primary,
                          0.08,
                        )} 50%, ${alpha(
                          theme.palette.text.primary,
                          0.04,
                        )} 100%)`,
                        backgroundSize: "200px 100%",
                        animation: "sqlShimmer 1.4s ease-in-out infinite",
                      }}
                    />
                  ))}
                </Box>
              )}
              {!schemaLoading && filteredSchemaTables.length === 0 && (
                <Typography
                  variant="caption"
                  sx={{
                    display: "block",
                    px: 1.25,
                    py: 1.5,
                    textAlign: "center",
                    color: theme.palette.text.disabled,
                  }}
                >
                  {t("sqlConsole.schema.empty")}
                </Typography>
              )}
              <List dense disablePadding>
                {filteredSchemaTables.map((tbl) => {
                  const tableCount = counts?.[tbl.name] ?? null;
                  const isExpanded = Boolean(expandedTables[tbl.name]);
                  return (
                    <Box key={tbl.name}>
                      <ListItemButton
                        onClick={() =>
                          setExpandedTables((x) => ({
                            ...x,
                            [tbl.name]: !x[tbl.name],
                          }))
                        }
                        sx={{
                          py: 0.25,
                          "&:hover": {
                            background: alpha(
                              theme.palette.primary.main,
                              0.04,
                            ),
                          },
                        }}
                      >
                        <ListItemText
                          primary={
                            <Box
                              display="flex"
                              alignItems="center"
                              gap={0.5}
                            >
                              {isExpanded ? (
                                <ExpandMoreIcon sx={{ fontSize: 14 }} />
                              ) : (
                                <ChevronRightIcon sx={{ fontSize: 14 }} />
                              )}
                              <Typography
                                variant="body2"
                                sx={{
                                  fontFamily: MONO_FONT,
                                  fontSize: 12,
                                  fontWeight: 600,
                                }}
                              >
                                {tbl.name}
                              </Typography>
                              {tableCount != null && (
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                  sx={{
                                    fontSize: 10,
                                    fontFamily: MONO_FONT,
                                  }}
                                >
                                  {formatRowCount(tableCount)}
                                </Typography>
                              )}
                              <Box flex={1} />
                              <Button
                                size="small"
                                variant="text"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  browseFile(tbl.name);
                                }}
                                sx={{
                                  minWidth: 0,
                                  fontSize: 10,
                                  py: 0,
                                  px: 0.75,
                                }}
                              >
                                {t("sqlConsole.schemaBrowseBtn")}
                              </Button>
                            </Box>
                          }
                        />
                      </ListItemButton>
                      <Collapse in={isExpanded}>
                        <Box
                          sx={{
                            pl: 3.5,
                            pr: 1,
                            pb: 0.5,
                            fontSize: 11,
                            fontFamily: MONO_FONT,
                          }}
                        >
                          {(tbl.columns || []).map((c) => {
                            const colType = (c.type || "").toUpperCase();
                            const typeColor = TYPE_TO_COLOR(
                              colType.includes("INT")
                                ? "INTEGER"
                                : colType.includes("REAL") ||
                                    colType.includes("FLOAT") ||
                                    colType.includes("DOUBLE")
                                  ? "REAL"
                                  : "TEXT",
                              theme.palette,
                            );
                            return (
                              <Box
                                key={c.name}
                                onClick={() => {
                                  insertAtCursor(c.name);
                                  showSnack(
                                    t("sqlConsole.schemaInsertedToast", {
                                      name: c.name,
                                    }),
                                  );
                                }}
                                sx={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 0.5,
                                  py: 0.25,
                                  cursor: "pointer",
                                  borderRadius: 0.5,
                                  px: 0.5,
                                  "&:hover": {
                                    background: alpha(
                                      theme.palette.primary.main,
                                      0.08,
                                    ),
                                  },
                                }}
                              >
                                {c.pk ? (
                                  <Box
                                    component="span"
                                    sx={{
                                      fontSize: 10,
                                      color: theme.palette.warning.main,
                                      fontWeight: 700,
                                      minWidth: 12,
                                      textAlign: "center",
                                    }}
                                    aria-label="primary key"
                                    title="primary key"
                                  >
                                    ⚿
                                  </Box>
                                ) : (
                                  <Box
                                    component="span"
                                    sx={{ minWidth: 12 }}
                                  />
                                )}
                                <Box
                                  component="span"
                                  sx={{
                                    flex: 1,
                                    fontWeight: c.pk ? 700 : 500,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {c.name}
                                </Box>
                                <Box
                                  component="span"
                                  sx={{
                                    fontSize: 9,
                                    fontWeight: 700,
                                    letterSpacing: "0.04em",
                                    color: typeColor,
                                    opacity: 0.85,
                                    px: 0.4,
                                    borderRadius: 0.4,
                                    background: alpha(typeColor, 0.1),
                                    flexShrink: 0,
                                  }}
                                >
                                  {colType || "TEXT"}
                                </Box>
                              </Box>
                            );
                          })}
                        </Box>
                      </Collapse>
                    </Box>
                  );
                })}
              </List>
            </Box>
          </Box>
          <Tooltip
            title={t("sqlConsole.schema.toggle")}
            arrow
            placement="right"
          >
            <Box
              role="separator"
              aria-orientation="vertical"
              aria-label={t("sqlConsole.schema.toggle")}
              onMouseDown={handleSchemaSplitterMouseDown}
              sx={{
                width: 4,
                flexShrink: 0,
                cursor: "col-resize",
                background: "transparent",
                position: "relative",
                transition: "background-color 150ms ease",
                "&:hover": {
                  background: alpha(theme.palette.primary.main, 0.4),
                },
                "&::after": {
                  content: '""',
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  transform: "translate(-50%, -50%)",
                  width: 2,
                  height: 28,
                  borderRadius: 2,
                  background: alpha(theme.palette.text.primary, 0.18),
                  opacity: 0,
                  transition: "opacity 150ms ease",
                },
                "&:hover::after": { opacity: 1 },
              }}
            />
          </Tooltip>
        </>
      )}
    </>
  );
}
