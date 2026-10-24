/** The studio's look while `active`; the tree stays the same either way, so nothing below remounts. */

import React from "react";
import { GlobalStyles } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import { studioGlobalStyles, studioTheme } from "./studioTheme";

const asIs = (outer) => outer;

export default function StudioScope({ active = false, children }) {
  return (
    <ThemeProvider theme={active ? studioTheme : asIs}>
      {active && <GlobalStyles styles={studioGlobalStyles} />}
      {children}
    </ThemeProvider>
  );
}
