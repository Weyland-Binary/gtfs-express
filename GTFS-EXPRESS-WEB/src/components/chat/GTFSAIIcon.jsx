import React from "react";
import SvgIcon from "@mui/material/SvgIcon";

export default function GTFSAIIcon(props) {
  return (
    <SvgIcon viewBox="0 0 24 24" {...props}>

      <rect
        x="5" y="5" width="14" height="14" rx="2"
        fill="none" stroke="currentColor" strokeWidth="1.4"
      />

      <line x1="2.5" y1="8.5"  x2="5" y2="8.5"  stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <line x1="2.5" y1="12"   x2="5" y2="12"   stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <line x1="2.5" y1="15.5" x2="5" y2="15.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />

      <line x1="19" y1="8.5"  x2="21.5" y2="8.5"  stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <line x1="19" y1="12"   x2="21.5" y2="12"   stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <line x1="19" y1="15.5" x2="21.5" y2="15.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />

      <line x1="8.5"  y1="2.5" x2="8.5"  y2="5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <line x1="12"   y1="2.5" x2="12"   y2="5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <line x1="15.5" y1="2.5" x2="15.5" y2="5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />

      <line x1="8.5"  y1="19" x2="8.5"  y2="21.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <line x1="12"   y1="19" x2="12"   y2="21.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <line x1="15.5" y1="19" x2="15.5" y2="21.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />

      <text
        x="12" y="14"
        textAnchor="middle"
        fontSize="6"
        fontWeight="800"
        fontFamily="system-ui, -apple-system, sans-serif"
        letterSpacing="-0.5"
        fill="currentColor"
      >
        AI
      </text>

    </SvgIcon>
  );
}
