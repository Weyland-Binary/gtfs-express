                                                                                          import React, { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
                                                                                          import { Box, useTheme } from "@mui/material";
                                                                                          import { alpha } from "@mui/material/styles";
                                                                                          import { EditorState, Compartment } from "@codemirror/state";
                                                                                          import {
                                                                                            EditorView,
                                                                                            keymap,
                                                                                            lineNumbers,
                                                                                            highlightActiveLine,
                                                                                            highlightActiveLineGutter,
                                                                                            highlightSpecialChars,
                                                                                            drawSelection,
                                                                                            rectangularSelection,
                                                                                            Decoration,
                                                                                          } from "@codemirror/view";
                                                                                          import {
                                                                                            defaultKeymap,
                                                                                            history,
                                                                                            historyKeymap,
                                                                                            indentWithTab,
                                                                                          } from "@codemirror/commands";
                                                                                          import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
                                                                                          import {
                                                                                            bracketMatching,
                                                                                            defaultHighlightStyle,
                                                                                            syntaxHighlighting,
                                                                                            indentOnInput,
                                                                                            foldGutter,
                                                                                            foldKeymap,
                                                                                          } from "@codemirror/language";
                                                                                          import {
                                                                                            autocompletion,
                                                                                            completionKeymap,
                                                                                            closeBrackets,
                                                                                            closeBracketsKeymap,
                                                                                          } from "@codemirror/autocomplete";
                                                                                          import { sql, SQLite } from "@codemirror/lang-sql";
                                                                                          import { oneDark } from "@codemirror/theme-one-dark";
                                                                                          import { MONO_FONT } from "./constants";

                                                                                          /* ------------------------------------------------------------------ */
                                                                                          /* SQL keyword list — stable, dependency-free, used by autocompletion  */
                                                                                          /* ------------------------------------------------------------------ */

                                                                                          const SQL_KEYWORDS = [
                                                                                            "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT",
                                                                                            "OFFSET", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "OUTER JOIN",
                                                                                            "ON", "AS", "AND", "OR", "NOT", "NULL", "IS NULL", "IS NOT NULL",
                                                                                            "IN", "EXISTS", "BETWEEN", "LIKE", "GLOB", "DISTINCT", "ALL",
                                                                                            "UNION", "UNION ALL", "INTERSECT", "EXCEPT",
                                                                                            "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM",
                                                                                            "CREATE TABLE", "DROP TABLE", "ALTER TABLE",
                                                                                            "CASE", "WHEN", "THEN", "ELSE", "END",
                                                                                            "COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "SUBSTR", "CAST",
                                                                                            "ASC", "DESC", "WITH",
                                                                                          ];

                                                                                          /**
                                                                                          * Build the autocompletion source from the schema. We expose:
                                                                                          *   - all table names
                                                                                          *   - all column names (qualified with table.column when ambiguous)
                                                                                          *   - SQL keywords
                                                                                          *
                                                                                          * The lang-sql package already provides keyword + builtin completion; we
                                                                                          * augment it with the GTFS schema so users get instant column hints.
                                                                                          */
                                                                                          function buildSchemaCompletion(schemaTables) {
                                                                                            return (context) => {
                                                                                              const word = context.matchBefore(/[\w]*/);
                                                                                              if (!word) return null;
                                                                                              if (word.from === word.to && !context.explicit) return null;

                                                                                              const options = [];

                                                                                              // Tables — type "type" to render with table icon.
                                                                                              for (const tbl of schemaTables) {
                                                                                                options.push({
                                                                                                  label: tbl.name,
                                                                                                  type: "type",
                                                                                                  boost: 10,
                                                                                                  detail: "table",
                                                                                                });
                                                                                                // Columns of each table
                                                                                                for (const col of tbl.columns || []) {
                                                                                                  options.push({
                                                                                                    label: col.name,
                                                                                                    type: col.pk ? "constant" : "property",
                                                                                                    detail: `${tbl.name}.${col.type || ""}${col.pk ? " PK" : ""}`,
                                                                                                    boost: col.pk ? 5 : 1,
                                                                                                  });
                                                                                                }
                                                                                              }

                                                                                              // SQL keywords (lower priority than schema items so columns surface first)
                                                                                              for (const kw of SQL_KEYWORDS) {
                                                                                                options.push({
                                                                                                  label: kw,
                                                                                                  type: "keyword",
                                                                                                  boost: -10,
                                                                                                });
                                                                                              }

                                                                                              return {
                                                                                                from: word.from,
                                                                                                options,
                                                                                                validFor: /^[\w]*$/,
                                                                                              };
                                                                                            };
                                                                                          }

                                                                                          /* ------------------------------------------------------------------ */
                                                                                          /* Build the CodeMirror theme aligned with MUI palette                 */
                                                                                          /* ------------------------------------------------------------------ */

                                                                                          function buildThemeExtension(theme, isDark) {
                                                                                            return EditorView.theme(
                                                                                              {
                                                                                                "&": {
                                                                                                  backgroundColor: "transparent",
                                                                                                  color: theme.palette.text.primary,
                                                                                                  fontSize: "13px",
                                                                                                  fontFamily: MONO_FONT,
                                                                                                },
                                                                                                ".cm-content": {
                                                                                                  caretColor: theme.palette.primary.main,
                                                                                                  padding: "8px 0",
                                                                                                },
                                                                                                ".cm-gutters": {
                                                                                                  backgroundColor: isDark
                                                                                                    ? alpha(theme.palette.common.black, 0.35)
                                                                                                    : alpha(theme.palette.common.black, 0.04),
                                                                                                  color: theme.palette.text.secondary,
                                                                                                  border: "none",
                                                                                                  borderRight: `1px solid ${theme.palette.divider}`,
                                                                                                },
                                                                                                ".cm-activeLineGutter": {
                                                                                                  backgroundColor: alpha(theme.palette.primary.main, 0.12),
                                                                                                  color: theme.palette.primary.main,
                                                                                                },
                                                                                                ".cm-activeLine": {
                                                                                                  backgroundColor: isDark
                                                                                                    ? alpha(theme.palette.primary.main, 0.06)
                                                                                                    : alpha(theme.palette.primary.main, 0.04),
                                                                                                },
                                                                                                ".cm-cursor, .cm-dropCursor": {
                                                                                                  borderLeftColor: theme.palette.primary.main,
                                                                                                  borderLeftWidth: "2px",
                                                                                                },
                                                                                                "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
                                                                                                  backgroundColor: alpha(theme.palette.primary.main, 0.25),
                                                                                                },
                                                                                                ".cm-tooltip": {
                                                                                                  backgroundColor: theme.palette.background.paper,
                                                                                                  color: theme.palette.text.primary,
                                                                                                  border: `1px solid ${theme.palette.divider}`,
                                                                                                  borderRadius: "4px",
                                                                                                },
                                                                                                ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
                                                                                                  backgroundColor: alpha(theme.palette.primary.main, 0.18),
                                                                                                  color: theme.palette.primary.main,
                                                                                                },
                                                                                                ".cm-tooltip-autocomplete .cm-completionLabel": {
                                                                                                  fontFamily: MONO_FONT,
                                                                                                },
                                                                                                ".cm-tooltip-autocomplete .cm-completionDetail": {
                                                                                                  opacity: 0.65,
                                                                                                  fontStyle: "normal",
                                                                                                },
                                                                                                ".cm-error-line": {
                                                                                                  backgroundColor: alpha(theme.palette.error.main, 0.15),
                                                                                                  borderLeft: `3px solid ${theme.palette.error.main}`,
                                                                                                },
                                                                                                ".cm-foldPlaceholder": {
                                                                                                  backgroundColor: alpha(theme.palette.primary.main, 0.1),
                                                                                                  color: theme.palette.primary.main,
                                                                                                  border: "none",
                                                                                                },
                                                                                                ".cm-matchingBracket": {
                                                                                                  backgroundColor: alpha(theme.palette.primary.main, 0.25),
                                                                                                  outline: `1px solid ${alpha(theme.palette.primary.main, 0.5)}`,
                                                                                                },
                                                                                                ".cm-searchMatch": {
                                                                                                  backgroundColor: alpha(theme.palette.warning.main, 0.3),
                                                                                                },
                                                                                              },
                                                                                              { dark: isDark },
                                                                                            );
                                                                                          }

                                                                                          /* ------------------------------------------------------------------ */
                                                                                          /* Decoration for highlighting an error line                           */
                                                                                          /* ------------------------------------------------------------------ */

                                                                                          const errorLineMark = Decoration.line({ attributes: { class: "cm-error-line" } });

                                                                                          /* ------------------------------------------------------------------ */
                                                                                          /* CodeMirrorQueryEditor                                               */
                                                                                          /* ------------------------------------------------------------------ */

                                                                                          /**
                                                                                          * Modular CodeMirror 6 editor for SQL queries.
                                                                                          *
                                                                                          * Props:
                                                                                          *   - value: current query string
                                                                                          *   - onChange: (next) => void
                                                                                          *   - onRunQuery: () => void  (Ctrl+Enter)
                                                                                          *   - onSavePreset: () => void (Ctrl+S)
                                                                                          *   - onClearAll: () => void (Ctrl+L)
                                                                                          *   - schemaTables: [{name, columns}]
                                                                                          *   - isDarkMode: bool
                                                                                          *   - height, minHeight, maxHeight: layout
                                                                                          *   - errorLine: 1-based line number to highlight (optional)
                                                                                          *   - placeholder: ARIA label
                                                                                          */
                                                                                          const CodeMirrorQueryEditor = forwardRef(function CodeMirrorQueryEditor(
                                                                                            {
                                                                                              value,
                                                                                              onChange,
                                                                                              onRunQuery,
                                                                                              onSavePreset,
                                                                                              onClearAll,
                                                                                              schemaTables = [],
                                                                                              isDarkMode = false,
                                                                                              height = "180px",
                                                                                              placeholder = "SQL query",
                                                                                              errorLine = null,
                                                                                            },
                                                                                            ref,
                                                                                          ) {
                                                                                            const theme = useTheme();
                                                                                            const containerRef = useRef(null);
                                                                                            const viewRef = useRef(null);

                                                                                            // Compartments allow swapping a single extension at runtime without
                                                                                            // tearing down the editor (theme changes, schema reloads, etc.).
                                                                                            const themeCompartment = useRef(new Compartment());
                                                                                            const completionCompartment = useRef(new Compartment());
                                                                                            const errorLineCompartment = useRef(new Compartment());

                                                                                            // Stable refs to handlers — keymap captures these by reference so changes
                                                                                            // are picked up without rebuilding the editor.
                                                                                            const handlersRef = useRef({ onRunQuery, onSavePreset, onClearAll, onChange });
                                                                                            useEffect(() => {
                                                                                              handlersRef.current = { onRunQuery, onSavePreset, onClearAll, onChange };
                                                                                            }, [onRunQuery, onSavePreset, onClearAll, onChange]);

                                                                                            // Build error-line decoration extension on demand.
                                                                                            const buildErrorLineExtension = (line) => {
                                                                                              if (!line || line < 1) return [];
                                                                                              return EditorView.decorations.of((view) => {
                                                                                                try {
                                                                                                  const ln = view.state.doc.line(line);
                                                                                                  return Decoration.set([errorLineMark.range(ln.from)]);
                                                                                                } catch {
                                                                                                  return Decoration.none;
                                                                                                }
                                                                                              });
                                                                                            };

                                                                                            /* --- mount: build the editor once, ref-stable handlers ---------- */
                                                                                            useEffect(() => {
                                                                                              if (!containerRef.current) return undefined;

                                                                                              const customKeymap = keymap.of([
                                                                                                {
                                                                                                  key: "Mod-Enter",
                                                                                                  preventDefault: true,
                                                                                                  run: () => {
                                                                                                    handlersRef.current.onRunQuery?.();
                                                                                                    return true;
                                                                                                  },
                                                                                                },
                                                                                                {
                                                                                                  key: "Mod-s",
                                                                                                  preventDefault: true,
                                                                                                  run: () => {
                                                                                                    handlersRef.current.onSavePreset?.();
                                                                                                    return true;
                                                                                                  },
                                                                                                },
                                                                                                {
                                                                                                  key: "Mod-l",
                                                                                                  preventDefault: true,
                                                                                                  run: () => {
                                                                                                    handlersRef.current.onClearAll?.();
                                                                                                    return true;
                                                                                                  },
                                                                                                },
                                                                                                indentWithTab,
                                                                                              ]);

                                                                                              const updateListener = EditorView.updateListener.of((update) => {
                                                                                                if (update.docChanged) {
                                                                                                  const next = update.state.doc.toString();
                                                                                                  handlersRef.current.onChange?.(next);
                                                                                                }
                                                                                              });

                                                                                              const state = EditorState.create({
                                                                                                doc: value || "",
                                                                                                extensions: [
                                                                                                  lineNumbers(),
                                                                                                  highlightActiveLineGutter(),
                                                                                                  highlightSpecialChars(),
                                                                                                  history(),
                                                                                                  foldGutter(),
                                                                                                  drawSelection(),
                                                                                                  EditorState.allowMultipleSelections.of(true),
                                                                                                  indentOnInput(),
                                                                                                  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
                                                                                                  bracketMatching(),
                                                                                                  closeBrackets(),
                                                                                                  completionCompartment.current.of(
                                                                                                    autocompletion({
                                                                                                      override: [buildSchemaCompletion(schemaTables)],
                                                                                                      activateOnTyping: true,
                                                                                                      maxRenderedOptions: 30,
                                                                                                      defaultKeymap: true,
                                                                                                    }),
                                                                                                  ),
                                                                                                  rectangularSelection(),
                                                                                                  highlightActiveLine(),
                                                                                                  highlightSelectionMatches(),
                                                                                                  sql({ dialect: SQLite, upperCaseKeywords: true }),
                                                                                                  keymap.of([
                                                                                                    ...closeBracketsKeymap,
                                                                                                    ...defaultKeymap,
                                                                                                    ...searchKeymap,
                                                                                                    ...historyKeymap,
                                                                                                    ...foldKeymap,
                                                                                                    ...completionKeymap,
                                                                                                  ]),
                                                                                                  customKeymap,
                                                                                                  themeCompartment.current.of([
                                                                                                    buildThemeExtension(theme, isDarkMode),
                                                                                                    isDarkMode ? oneDark : [],
                                                                                                  ]),
                                                                                                  errorLineCompartment.current.of(buildErrorLineExtension(errorLine)),
                                                                                                  updateListener,
                                                                                                  EditorView.contentAttributes.of({
                                                                                                    "aria-label": placeholder,
                                                                                                    spellcheck: "false",
                                                                                                  }),
                                                                                                  EditorView.lineWrapping,
                                                                                                ],
                                                                                              });

                                                                                              const view = new EditorView({
                                                                                                state,
                                                                                                parent: containerRef.current,
                                                                                              });
                                                                                              viewRef.current = view;

                                                                                              return () => {
                                                                                                view.destroy();
                                                                                                viewRef.current = null;
                                                                                              };
                                                                                              // eslint-disable-next-line
                                                                                            }, []); // mount once; everything else is updated via compartments

                                                                                            /* --- sync external `value` -> editor doc ----------------------- */
                                                                                            useEffect(() => {
                                                                                              const view = viewRef.current;
                                                                                              if (!view) return;
                                                                                              const current = view.state.doc.toString();
                                                                                              if (current !== value) {
                                                                                                view.dispatch({
                                                                                                  changes: { from: 0, to: current.length, insert: value || "" },
                                                                                                });
                                                                                              }
                                                                                            }, [value]);

                                                                                            /* --- swap theme compartment when palette/mode changes ---------- */
                                                                                            useEffect(() => {
                                                                                              const view = viewRef.current;
                                                                                              if (!view) return;
                                                                                              view.dispatch({
                                                                                                effects: themeCompartment.current.reconfigure([
                                                                                                  buildThemeExtension(theme, isDarkMode),
                                                                                                  isDarkMode ? oneDark : [],
                                                                                                ]),
                                                                                              });
                                                                                            }, [theme, isDarkMode]);

                                                                                            /* --- swap completion source when schema changes ---------------- */
                                                                                            useEffect(() => {
                                                                                              const view = viewRef.current;
                                                                                              if (!view) return;
                                                                                              view.dispatch({
                                                                                                effects: completionCompartment.current.reconfigure(
                                                                                                  autocompletion({
                                                                                                    override: [buildSchemaCompletion(schemaTables)],
                                                                                                    activateOnTyping: true,
                                                                                                    maxRenderedOptions: 30,
                                                                                                    defaultKeymap: true,
                                                                                                  }),
                                                                                                ),
                                                                                              });
                                                                                            }, [schemaTables]);

                                                                                            /* --- swap error-line decoration -------------------------------- */
                                                                                            useEffect(() => {
                                                                                              const view = viewRef.current;
                                                                                              if (!view) return;
                                                                                              view.dispatch({
                                                                                                effects: errorLineCompartment.current.reconfigure(
                                                                                                  buildErrorLineExtension(errorLine),
                                                                                                ),
                                                                                              });
                                                                                            }, [errorLine]);

                                                                                            /* --- expose imperative API ------------------------------------ */
                                                                                            useImperativeHandle(ref, () => ({
                                                                                              focus: () => viewRef.current?.focus(),
                                                                                              insertAtCursor: (text) => {
                                                                                                const view = viewRef.current;
                                                                                                if (!view) return;
                                                                                                const sel = view.state.selection.main;
                                                                                                view.dispatch({
                                                                                                  changes: { from: sel.from, to: sel.to, insert: text },
                                                                                                  selection: { anchor: sel.from + text.length },
                                                                                                });
                                                                                                view.focus();
                                                                                              },
                                                                                              getView: () => viewRef.current,
                                                                                            }));

                                                                                            return (
                                                                                              <Box
                                                                                                ref={containerRef}
                                                                                                sx={{
                                                                                                  height,
                                                                                                  border: `1px solid ${theme.palette.divider}`,
                                                                                                  borderRadius: 1,
                                                                                                  overflow: "auto",
                                                                                                  backgroundColor: isDarkMode
                                                                                                    ? alpha(theme.palette.common.black, 0.25)
                                                                                                    : alpha(theme.palette.common.black, 0.02),
                                                                                                  "&:focus-within": {
                                                                                                    borderColor: theme.palette.primary.main,
                                                                                                    boxShadow: `0 0 0 1px ${alpha(theme.palette.primary.main, 0.4)}`,
                                                                                                  },
                                                                                                  "& .cm-editor": {
                                                                                                    height: "100%",
                                                                                                    outline: "none",
                                                                                                  },
                                                                                                  "& .cm-scroller": {
                                                                                                    overflow: "auto",
                                                                                                  },
                                                                                                }}
                                                                                              />
                                                                                            );
                                                                                          });

                                                                                          export default CodeMirrorQueryEditor;
