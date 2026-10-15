import React from "react";
import Box from "@mui/material/Box";
import Skeleton from "@mui/material/Skeleton";

// Shared loading placeholder for detail panels (stop, route, trip,
// calendar…). Mirrors the common layout — coloured header band, a chip
// row, then content blocks — so the panel keeps its silhouette while the
// *_detail fetch is in flight instead of collapsing to a spinner.
// ShapeDetail keeps its bespoke skeleton (map-shaped blocks).
const PanelSkeleton = () => (
  <Box display="flex" flexDirection="column" gap={1.5} data-testid="panel-skeleton">
    <Skeleton variant="rounded" height={96} sx={{ borderRadius: 3 }} />
    <Box display="flex" gap={1}>
      <Skeleton variant="rounded" width={84} height={26} sx={{ borderRadius: 13 }} />
      <Skeleton variant="rounded" width={64} height={26} sx={{ borderRadius: 13 }} />
      <Skeleton variant="rounded" width={96} height={26} sx={{ borderRadius: 13 }} />
    </Box>
    <Skeleton variant="rounded" height={110} sx={{ borderRadius: 2 }} />
    <Skeleton variant="rounded" height={72} sx={{ borderRadius: 2 }} />
    <Skeleton variant="rounded" height={72} sx={{ borderRadius: 2 }} />
  </Box>
);

export default PanelSkeleton;
