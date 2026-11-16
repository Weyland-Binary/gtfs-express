/**
 * The community edition reads a network and never edits it: edit mode stays off, and an act that would change the
 * network opens the hosted edition's message. The toasts are the same as the hosted edition's.
 */
import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Snackbar, Alert, Slide, Button, IconButton } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { useLanguage } from "./LanguageContext";
import HostedOnly from "../components/common/HostedOnly";

const EditModeContext = createContext(null);
const ToastContext = createContext(null);

function SlideUp(props) {
  return <Slide {...props} direction="up" />;
}

export function ToastProvider({ children }) {
  const { t } = useLanguage();
  const [toast, setToast] = useState(null);

  // `action`: { label, onClick }, a button inside the snackbar.
  const showToast = useCallback((message, severity = "success", action = null) => {
    setToast({ message, severity, action, key: Date.now() });
  }, []);

  const closeToast = useCallback(() => setToast(null), []);

  const value = useMemo(() => ({ showToast, closeToast }), [showToast, closeToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Snackbar
        key={toast?.key}
        open={Boolean(toast)}
        autoHideDuration={toast?.action ? 6000 : 3500}
        onClose={closeToast}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        sx={{ bottom: { xs: 112, sm: 96 } }}
        TransitionComponent={SlideUp}
      >
        {toast ? (
          <Alert
            onClose={closeToast}
            severity={toast.severity}
            variant="filled"
            action={
              toast.action ? (
                <>
                  <Button
                    color="inherit"
                    size="small"
                    onClick={() => {
                      closeToast();
                      toast.action.onClick();
                    }}
                    sx={{ fontWeight: 700, textTransform: "none" }}
                  >
                    {toast.action.label}
                  </Button>
                  <IconButton size="small" color="inherit" aria-label={t("app.cancel")} onClick={closeToast}>
                    <CloseIcon fontSize="inherit" />
                  </IconButton>
                </>
              ) : undefined
            }
            sx={{ minWidth: 280, boxShadow: "0 8px 24px rgba(0,0,0,0.18)", fontWeight: 600, alignItems: "center" }}
          >
            {toast.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider (EditModeProvider includes one)");
  return ctx;
}

export function EditModeProvider({ children }) {
  return (
    <ToastProvider>
      <EditModeState>{children}</EditModeState>
    </ToastProvider>
  );
}

const noop = () => {};

function EditModeState({ children }) {
  const { showToast } = useToast();
  const [hostedOpen, setHostedOpen] = useState(false);
  const hosted = useCallback(async () => {
    setHostedOpen(true);
    return { ok: false, errorCode: "HOSTED_EDITION_ONLY" };
  }, []);

  const value = useMemo(
    () => ({
      editing: false,
      statusReady: true,
      entering: false,
      counts: null,
      pendingEdits: 0,
      undoneEdits: 0,
      unsavedChanges: 0,
      touchedEntities: {},
      clearTouchedEntities: noop,
      dataVersion: 0,
      stopOverrides: {},
      undoing: false,
      redoing: false,
      error: null,
      enterEditMode: hosted,
      exitEditMode: async () => ({ ok: true }),
      resetEditStateLocal: noop,
      refreshStatus: async () => null,
      undoLast: hosted,
      redoLast: hosted,
      jumpToHistory: hosted,
      exportGTFS: hosted,
      recordEdit: noop,
      patchStop: noop,
      showToast,
      clearError: noop,
      lastValidationResult: null,
      clearValidationResult: noop,
      editHold: null,
      holdEditing: noop,
      releaseEditing: noop,
    }),
    [hosted, showToast],
  );

  return (
    <EditModeContext.Provider value={value}>
      {children}
      <HostedOnly variant="dialog" open={hostedOpen} onClose={() => setHostedOpen(false)} />
    </EditModeContext.Provider>
  );
}

export function useEditMode() {
  const ctx = useContext(EditModeContext);
  if (!ctx) throw new Error("useEditMode must be used within an EditModeProvider");
  return ctx;
}
