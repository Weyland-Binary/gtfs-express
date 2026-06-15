import React, { useMemo, useState } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  Chip,
  Divider,
  TextField,
  InputAdornment,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import KeyboardIcon from "@mui/icons-material/Keyboard";
import SearchIcon from "@mui/icons-material/Search";
import {
  useShortcuts,
  useKeyboardShortcut,
  formatChord,
} from "../contexts/ShortcutsContext";
import { useLanguage } from "../contexts/LanguageContext";

const CATEGORY_ORDER = [
  "edit",
  "navigation",
  "selection",
  "general",
  "advanced",
];

function Kbd({ children }) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  return (
    <Box
      component="kbd"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "monospace",
        fontSize: 11,
        fontWeight: 600,
        px: 0.75,
        py: 0.25,
        minWidth: 22,
        height: 22,
        borderRadius: 0.75,
        border: `1px solid ${
          isDark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.18)"
        }`,
        background: isDark ? "rgba(255,255,255,0.06)" : "#f7f7f8",
        color: isDark ? "#e2e8f0" : "#334155",
        boxShadow: isDark
          ? "0 1px 0 rgba(0,0,0,0.4)"
          : "0 1px 0 rgba(0,0,0,0.08)",
      }}
    >
      {children}
    </Box>
  );
}

function ShortcutsHelpDialog() {
  const { t } = useLanguage();
  const { list, isMac } = useShortcuts();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  useKeyboardShortcut({
    id: "help.open",
    keys: ["shift+?", "shift+/"],
    description: t("shortcuts.help.openShortcut"),
    category: "general",
    handler: (e) => {
      e.preventDefault();
      setOpen(true);
    },
  });

  useKeyboardShortcut({
    id: "help.close",
    keys: ["esc"],
    description: "",
    when: () => open,
    handler: () => setOpen(false),
  });

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return list.filter((s) => {
      if (!s.description) return false;
      if (s.when && !s.when()) return false;
      if (!q) return true;
      const hay = [s.description, ...(s.keys || [])].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [list, filter]);

  const grouped = useMemo(() => {
    const byCat = new Map();
    for (const s of visible) {
      const cat = s.category || "general";
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(s);
    }
    const orderedCats = [
      ...CATEGORY_ORDER.filter((c) => byCat.has(c)),
      ...Array.from(byCat.keys()).filter((c) => !CATEGORY_ORDER.includes(c)),
    ];
    return orderedCats.map((cat) => ({ category: cat, items: byCat.get(cat) }));
  }, [visible]);

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      maxWidth="sm"
      fullWidth
      PaperProps={{ sx: { borderRadius: 2 } }}
    >
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
        <Box
          sx={{
            width: 36,
            height: 36,
            borderRadius: 1.5,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: (theme) =>
              theme.palette.mode === "dark"
                ? "rgba(99,102,241,0.18)"
                : "rgba(99,102,241,0.12)",
            color: "primary.main",
          }}
        >
          <KeyboardIcon />
        </Box>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h6" fontWeight={700} lineHeight={1.2}>
            {t("shortcuts.help.title")}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t("shortcuts.help.subtitle")}
          </Typography>
        </Box>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <Box sx={{ px: 2, py: 1.25 }}>
          <TextField
            autoFocus
            fullWidth
            size="small"
            placeholder={t("shortcuts.help.searchPlaceholder")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
          />
        </Box>
        <Divider />
        <Box sx={{ maxHeight: 440, overflow: "auto" }}>
          {grouped.length === 0 ? (
            <Box p={3} textAlign="center">
              <Typography variant="body2" color="text.secondary">
                {t("shortcuts.help.empty")}
              </Typography>
            </Box>
          ) : (
            grouped.map(({ category, items }) => (
              <Box key={category} sx={{ px: 2, py: 1.25 }}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    fontWeight: 700,
                    fontSize: 10,
                  }}
                >
                  {t(`shortcuts.category.${category}`)}
                </Typography>
                <Box sx={{ mt: 0.75 }}>
                  {items.map((s) => (
                    <Box
                      key={s.id}
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 2,
                        py: 0.6,
                      }}
                    >
                      <Typography
                        variant="body2"
                        sx={{ flex: 1, fontSize: 13 }}
                      >
                        {s.description}
                      </Typography>
                      <Box sx={{ display: "flex", gap: 0.5 }}>
                        {s.keys.slice(0, 2).map((k, i) => (
                          <React.Fragment key={i}>
                            {i > 0 && (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                sx={{ alignSelf: "center", fontSize: 10 }}
                              >
                                {t("shortcuts.help.orSeparator")}
                              </Typography>
                            )}
                            <Kbd>{formatChord(k, isMac)}</Kbd>
                          </React.Fragment>
                        ))}
                      </Box>
                    </Box>
                  ))}
                </Box>
              </Box>
            ))
          )}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 2, py: 1.25 }}>
        <Chip
          size="small"
          label={
            <span>
              {t("shortcuts.help.pressKey")} <Kbd>?</Kbd>
            </span>
          }
          variant="outlined"
          sx={{ mr: "auto", fontSize: 11 }}
        />
        <Button onClick={() => setOpen(false)}>{t("app.close")}</Button>
      </DialogActions>
    </Dialog>
  );
}

export default ShortcutsHelpDialog;
