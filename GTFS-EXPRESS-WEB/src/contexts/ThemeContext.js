import React, { createContext, useContext, useState, useEffect } from "react";

const ThemeContext = createContext();

export const useThemeMode = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useThemeMode must be used within a ThemeModeProvider");
  }
  return context;
};

export const ThemeModeProvider = ({ children }) => {
  // Retrieve saved preference or use system preference
  const getInitialMode = () => {
    const savedMode = localStorage.getItem("themeMode");
    if (savedMode) {
      return savedMode;
    }
    // Check system preference
    if (
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    ) {
      return "dark";
    }
    return "light";
  };

  const [mode, setMode] = useState(getInitialMode);

  // Save preference to localStorage
  useEffect(() => {
    localStorage.setItem("themeMode", mode);
    // Add a class to the body for global CSS styles
    document.body.classList.remove("light-mode", "dark-mode");
    document.body.classList.add(`${mode}-mode`);
  }, [mode]);

  const toggleMode = () => {
    setMode((prevMode) => (prevMode === "light" ? "dark" : "light"));
  };

  const value = {
    mode,
    toggleMode,
    isDark: mode === "dark",
  };

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
};

export default ThemeContext;
