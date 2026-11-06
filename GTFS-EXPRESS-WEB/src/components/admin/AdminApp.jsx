/** The operator's console: the hosted edition's, in the community edition. */
import React from "react";
import { Box } from "@mui/material";
import HostedOnly from "../common/HostedOnly";

export default function AdminApp() {
  return (
    <Box sx={{ minHeight: "100vh", display: "flex", bgcolor: "background.default" }}>
      <HostedOnly />
    </Box>
  );
}
