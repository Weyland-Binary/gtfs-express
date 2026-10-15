/**
 * StudioScope — draws what it holds in the Network Studio's look
 * (studioTheme) while `active`: the project's pages, create and modify. The
 * tree is the same either way (the theme only changes), so nothing below
 * remounts when the person goes from a project to the explorer and back.
 */

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
