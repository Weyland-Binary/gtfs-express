import React from "react";

// Inline JSX version of logo.svg. CRA's `ReactComponent` SVG import (SVGR)
// does not exist under Vite; with a single consumer (the header), inlining
// the 1 KB logo beats adding a plugin for it. Keep in sync with
// src/assets/logo.svg (still used as a plain-URL asset if ever needed).
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
      {/* GTFS: currentColor, so it follows the theme */}
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

      {/* Chevron: fixed accent — readable on light AND dark backgrounds */}
      <g transform="translate(672, 90)">
        <path d="M 0 0 L 78 75 L 0 150 L 38 150 L 116 75 L 38 0 Z" fill="url(#accent)" />
      </g>

      {/* EXPRESS: currentColor as well */}
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
