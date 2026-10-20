/**
 * Deferred — a screen loaded on demand: a thin progress bar (named by the theme's default) while its code arrives.
 * Shared by the app's shell and the reader's views, which lazy-load the heavy screens (the grid, the maps, the
 * consoles, the pages) so Home draws without reading the whole bundle.
 */
import React, { Suspense } from "react";
import LinearProgress from "@mui/material/LinearProgress";

const Deferred = ({ children }) => <Suspense fallback={<LinearProgress sx={{ flexShrink: 0 }} />}>{children}</Suspense>;

export default Deferred;
