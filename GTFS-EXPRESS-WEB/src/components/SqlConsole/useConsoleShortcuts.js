import { useCallback } from "react";
import { useKeyboardShortcut } from "../../contexts/ShortcutsContext";
import { FILE_PRESET_SHORTCUTS } from "./presetQueries";

export default function useConsoleShortcuts({
  t,
  runQuery,
  query,
  setSavePresetName,
  setSavePresetOpen,
  handleClearAll,
  browseFile,
  setHelpOpen,
  setSchemaVisible,
}) {
  useKeyboardShortcut({
    id: "sqlConsole.run",
    keys: ["mod+enter"],
    description: t("sqlConsole.kbd.run"),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      runQuery();
    },
  });

  useKeyboardShortcut({
    id: "sqlConsole.savePreset",
    keys: ["mod+s"],
    description: t("sqlConsole.kbd.savePreset"),
    category: "advanced",
    allowInInputs: true,
    when: () => Boolean(query.trim()),
    handler: (e) => {
      e.preventDefault();
      setSavePresetName("");
      setSavePresetOpen(true);
    },
  });

  useKeyboardShortcut({
    id: "sqlConsole.clearAll",
    keys: ["mod+l"],
    description: t("sqlConsole.kbd.clearAll"),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      handleClearAll();
    },
  });

  // The nine registrations are unrolled: the rules of hooks want a fixed
  // number of calls (#18).
  const browseByIndex = useCallback(
    (idx) => {
      const table = FILE_PRESET_SHORTCUTS[idx];
      if (table) browseFile(table);
    },
    [browseFile],
  );
  useKeyboardShortcut({
    id: "sqlConsole.file.1",
    keys: ["mod+1"],
    description: t("sqlConsole.kbd.fileJump", {
      table: FILE_PRESET_SHORTCUTS[0],
    }),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      browseByIndex(0);
    },
  });
  useKeyboardShortcut({
    id: "sqlConsole.file.2",
    keys: ["mod+2"],
    description: t("sqlConsole.kbd.fileJump", {
      table: FILE_PRESET_SHORTCUTS[1],
    }),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      browseByIndex(1);
    },
  });
  useKeyboardShortcut({
    id: "sqlConsole.file.3",
    keys: ["mod+3"],
    description: t("sqlConsole.kbd.fileJump", {
      table: FILE_PRESET_SHORTCUTS[2],
    }),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      browseByIndex(2);
    },
  });
  useKeyboardShortcut({
    id: "sqlConsole.file.4",
    keys: ["mod+4"],
    description: t("sqlConsole.kbd.fileJump", {
      table: FILE_PRESET_SHORTCUTS[3],
    }),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      browseByIndex(3);
    },
  });
  useKeyboardShortcut({
    id: "sqlConsole.file.5",
    keys: ["mod+5"],
    description: t("sqlConsole.kbd.fileJump", {
      table: FILE_PRESET_SHORTCUTS[4],
    }),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      browseByIndex(4);
    },
  });
  useKeyboardShortcut({
    id: "sqlConsole.file.6",
    keys: ["mod+6"],
    description: t("sqlConsole.kbd.fileJump", {
      table: FILE_PRESET_SHORTCUTS[5],
    }),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      browseByIndex(5);
    },
  });
  useKeyboardShortcut({
    id: "sqlConsole.file.7",
    keys: ["mod+7"],
    description: t("sqlConsole.kbd.fileJump", {
      table: FILE_PRESET_SHORTCUTS[6],
    }),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      browseByIndex(6);
    },
  });
  useKeyboardShortcut({
    id: "sqlConsole.file.8",
    keys: ["mod+8"],
    description: t("sqlConsole.kbd.fileJump", {
      table: FILE_PRESET_SHORTCUTS[7],
    }),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      browseByIndex(7);
    },
  });
  useKeyboardShortcut({
    id: "sqlConsole.file.9",
    keys: ["mod+9"],
    description: t("sqlConsole.kbd.fileJump", {
      table: FILE_PRESET_SHORTCUTS[8],
    }),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      browseByIndex(8);
    },
  });

  // The console's own help sheet, not the global ShortcutsHelpDialog.
  useKeyboardShortcut({
    id: "sqlConsole.help",
    keys: ["shift+/"],
    description: t("sqlConsole.kbd.help"),
    category: "advanced",
    allowInInputs: false,
    handler: (e) => {
      e.preventDefault();
      setHelpOpen((v) => !v);
    },
  });

  useKeyboardShortcut({
    id: "sqlConsole.toggleSchema",
    keys: ["mod+\\"],
    description: t("sqlConsole.kbd.toggleSchema"),
    category: "advanced",
    allowInInputs: true,
    handler: (e) => {
      e.preventDefault();
      setSchemaVisible((v) => !v);
    },
  });
}
