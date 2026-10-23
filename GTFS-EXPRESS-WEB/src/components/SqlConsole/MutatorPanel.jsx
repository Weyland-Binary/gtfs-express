import React from "react";
import {
  Box,
  Button,
  Typography,
  TextField,
  Collapse,
  Fade,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  Paper,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { MONO_FONT } from "./constants";
import { highlightSqlInline } from "./sqlText";

/**
 * The inline mutator over a selection: a column, a value, the generated UPDATE shown, then applied or put in the
 * editor to run through the preview gate. Its state and handlers are useWriteBatch's.
 */
export default function MutatorPanel({
  mutatorOpen,
  setMutatorOpen,
  cellEditableEntity,
  selectedRows,
  mutatorColumn,
  setMutatorColumn,
  mutatorValue,
  setMutatorValue,
  mutatorEditableFields,
  mutatorFieldDef,
  generatedMutatorPreview,
  mutatorApplying,
  handleMutatorInsertInEditor,
  handleMutatorApply,
  t,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  return (
    <>
      <Collapse
        in={Boolean(mutatorOpen && cellEditableEntity)}
        timeout={200}
      >
        <Fade
          in={Boolean(mutatorOpen && cellEditableEntity)}
          timeout={200}
        >
          <Paper
            elevation={0}
            sx={{
              pl: 2,
              pr: 1.5,
              py: 1.25,
              mx: 1.5,
              mt: 1,
              mb: 0,
              border: `1px solid ${alpha(theme.palette.primary.main, 0.2)}`,
              borderLeft: `3px solid ${theme.palette.primary.main}`,
              borderRadius: 1,
              background: alpha(theme.palette.primary.main, 0.04),
              animation: "sqlSlideIn 200ms ease-out",
            }}
          >
            <Typography
              variant="caption"
              sx={{
                display: "block",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontSize: 10,
                color: theme.palette.text.secondary,
                mb: 0.75,
              }}
            >
              {t("sqlConsole.mutator.title", {
                count: selectedRows.size,
              })}
            </Typography>
            <Box
              sx={{
                display: "flex",
                gap: 0.75,
                alignItems: "flex-start",
                mb: 0.75,
                flexWrap: "wrap",
              }}
            >
              <FormControl size="small" sx={{ minWidth: 220 }}>
                <InputLabel>
                  {t("sqlConsole.mutator.pickColumn")}
                </InputLabel>
                <Select
                  value={mutatorColumn}
                  label={t("sqlConsole.mutator.pickColumn")}
                  onChange={(e) => {
                    setMutatorColumn(e.target.value);
                    setMutatorValue("");
                  }}
                >
                  {mutatorEditableFields.map((f) => (
                    <MenuItem key={f.key} value={f.key}>
                      <span style={{ fontFamily: MONO_FONT }}>
                        {f.key}
                      </span>
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              {mutatorFieldDef?.type === "enum" ? (
                <FormControl size="small" sx={{ minWidth: 220 }}>
                  <InputLabel>
                    {t("sqlConsole.mutator.setValue")}
                  </InputLabel>
                  <Select
                    value={mutatorValue}
                    label={t("sqlConsole.mutator.setValue")}
                    onChange={(e) =>
                      setMutatorValue(e.target.value)
                    }
                  >
                    <MenuItem value="">
                      <em>NULL</em>
                    </MenuItem>
                    {mutatorFieldDef.options.map((o) => (
                      <MenuItem key={o.value} value={o.value}>
                        {o.label}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              ) : (
                <TextField
                  size="small"
                  label={t("sqlConsole.mutator.setValue")}
                  type={
                    mutatorFieldDef?.type === "number"
                      ? "number"
                      : "text"
                  }
                  value={mutatorValue}
                  onChange={(e) => setMutatorValue(e.target.value)}
                  disabled={!mutatorColumn}
                  sx={{ minWidth: 220 }}
                />
              )}
            </Box>
            {generatedMutatorPreview && (
              <>
                <Typography
                  variant="caption"
                  sx={{
                    display: "block",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    fontSize: 9.5,
                    color: theme.palette.text.disabled,
                    mb: 0.5,
                  }}
                >
                  {t("sqlConsole.mutator.generatedSql")}
                </Typography>
                <Box
                  component="pre"
                  sx={{
                    m: 0,
                    p: 1.25,
                    fontFamily: MONO_FONT,
                    fontSize: 11.5,
                    lineHeight: 1.5,
                    background: alpha(
                      theme.palette.background.default,
                      isDark ? 0.6 : 0.7,
                    ),
                    border: `1px solid ${alpha(
                      theme.palette.text.primary,
                      0.08,
                    )}`,
                    borderRadius: 1,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                    mb: 1,
                  }}
                >
                  {(
                    highlightSqlInline(generatedMutatorPreview) ||
                    []
                  ).map((part, i) =>
                    part.kind === "kw" ? (
                      <Box
                        key={i}
                        component="span"
                        sx={{
                          color: theme.palette.primary.main,
                          fontWeight: 700,
                        }}
                      >
                        {part.value}
                      </Box>
                    ) : (
                      <span key={i}>{part.value}</span>
                    ),
                  )}
                </Box>
              </>
            )}
            <Box
              sx={{
                display: "flex",
                gap: 1,
                justifyContent: "flex-end",
              }}
            >
              <Button
                size="small"
                onClick={() => setMutatorOpen(false)}
                disabled={mutatorApplying}
              >
                {t("app.cancel")}
              </Button>
              <Button
                size="small"
                variant="outlined"
                onClick={handleMutatorInsertInEditor}
                disabled={!mutatorColumn || mutatorApplying}
              >
                {t("sqlConsole.mutator.insertInEditor")}
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={handleMutatorApply}
                disabled={!mutatorColumn || mutatorApplying}
              >
                {mutatorApplying
                  ? t("sqlConsole.running")
                  : t("sqlConsole.mutator.apply")}
              </Button>
            </Box>
          </Paper>
        </Fade>
      </Collapse>
    </>
  );
}
