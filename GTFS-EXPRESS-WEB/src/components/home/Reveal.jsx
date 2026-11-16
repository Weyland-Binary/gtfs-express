/**
 * Rises into view the first time it is seen, once. A transition, not an animation: an animation's fill would hold
 * its transform and override a card's own hover lift. Shown at once with reduced motion or without
 * IntersectionObserver, so nothing ever stays hidden.
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, useMediaQuery } from "@mui/material";

const EASE = "cubic-bezier(.16, 1, .3, 1)";

export default function Reveal({ children, delay = 0, component = "div", sx = {}, ...rest }) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (reduced || typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return undefined;
    }
    const node = ref.current;
    if (!node) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.1, rootMargin: "0px 0px -6% 0px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [reduced]);
  const motion = reduced
    ? {}
    : {
        opacity: seen ? 1 : 0,
        transform: seen ? "none" : "translateY(22px)",
        filter: seen ? "none" : "blur(4px)",
        transition: `opacity 0.7s ease ${delay}s, transform 0.9s ${EASE} ${delay}s, filter 0.7s ease ${delay}s`,
      };
  return (
    <Box ref={ref} component={component} data-revealed={seen ? "true" : "false"} sx={{ ...motion, ...sx }} {...rest}>
      {children}
    </Box>
  );
}
