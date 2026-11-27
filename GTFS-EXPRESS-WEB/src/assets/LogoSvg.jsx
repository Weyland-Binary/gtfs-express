import React from "react";

// Inline copy of src/assets/logo.svg (Vite has no SVG component import): keep the two in sync.
const LogoSvg = (props) => (
  <svg
    viewBox="0 0 1820 320"
    xmlns="http://www.w3.org/2000/svg"
    fill="currentColor"
    {...props}
  >
    <defs>
      <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stopColor="#0052FF" />
        <stop offset="100%" stopColor="#00B8FF" />
      </linearGradient>
    </defs>

    <g transform="skewX(-8)">
      <text
        x="100"
        y="240"
        fontFamily="Inter, system-ui, sans-serif"
        fontWeight="900"
        fontSize="200"
        letterSpacing="-6"
        fill="currentColor"
      >
        GTFS
      </text>

      {/* A fixed accent, readable on light and dark backgrounds */}
      <g transform="translate(672, 90)">
        <path d="M 0 0 L 78 75 L 0 150 L 38 150 L 116 75 L 38 0 Z" fill="url(#accent)" />
      </g>

      <text
        x="830"
        y="240"
        fontFamily="Inter, system-ui, sans-serif"
        fontWeight="900"
        fontSize="200"
        letterSpacing="-6"
        fill="currentColor"
      >
        EXPRESS
      </text>
    </g>
  </svg>
);

export default LogoSvg;
