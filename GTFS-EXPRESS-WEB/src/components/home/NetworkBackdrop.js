/**
 * NetworkBackdrop — one transit network under the whole of Home, from the head to the foot: under the text too for
 * depth, its lines linking the page's elements down to the bottom without stopping half way.
 *
 * Octilinear lines in the brand's accents: two braids in each margin, crossing at every gap between sections, and one
 * line weaving over the page at every gap, from one margin to the other, down to the foot; stations level with the
 * sections' headings as one reaches them; three vehicles a line running slowly. Three planes give the depth:
 *
 *   - the map moves slower than the page (parallax, PARALLAX of the scroll): a sticky layer as tall as the view, its
 *     map translated by the scroll, so it seems far below;
 *   - it shows fully in the margins and barely in the middle (a horizontal mask, CENTER_ALPHA): under the text the
 *     lines are a faint watermark, never a pattern one reads through;
 *   - the page's ink and its cards are planes of their own. Over the ink — the head's blue, which fades into the
 *     page over HEAD_FADE below its foot, and every section marked `data-ink` (« Le lecteur ») — the lines are lit in
 *     their colours (a second drawing, masked to those windows as they scroll, fading with the head's blue); under
 *     the paper they are one tone, the brand's blue, faint (coloured lines on white read as noise beside the cards,
 *     not as a drawing); under the cards hidden.
 *
 * Motion: the system's « reduce motion » stops the vehicles (the map then scrolls with the page), and so does a
 * hidden tab. There is deliberately no pause button: the accessibility statement lists it as a known
 * non-conformity (RGAA 13.8). Decorative only (aria-hidden), no pointer events, colours from the theme (#19).
 * `backdropNetwork()` is the map's geometry, pure, so it is tested as is.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, alpha, useTheme } from "@mui/material";

/** How fast the map follows the scroll (1: with the page; less: farther away). */
export const PARALLAX = 0.72;
/** How much of the map shows in the middle of the page, under the content (1 in the margins). */
export const CENTER_ALPHA = 0.26;
/** How far below the head's foot its blue fades into the page (HomeHero paints the fade, the lit lines follow it). */
export const HEAD_FADE = 380;
// The content's width the margins are measured against (Home's sections), and the vehicles' speed (px/s).
const CONTENT_WIDTH = 1180;
const SPEED = 55;

const round = (n) => Math.round(n * 10) / 10;

/** A path's « M x y L x y … » and its length, from its points. */
const pathOf = (points) => {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return { d: points.map(([x, y], i) => `${i ? "L" : "M"}${round(x)} ${round(y)}`).join(" "), length, points };
};

/**
 * The map: { lines: [{ id, tone, d, length, points }], stations: [{ x, y, tone, hub }] } for a layer `width` wide and
 * `height` tall, its stations at `stops` (y in the map's coordinates, sorted). Every segment is vertical, horizontal or
 * at 45°, as transit diagrams draw them.
 */
export function backdropNetwork({ width, height, stops = [] }) {
  const W = Math.max(320, width);
  const H = Math.max(400, height);
  const gutter = Math.max(44, (W - CONTENT_WIDTH) / 2);
  // Three slots in each margin, the outer two for the braids, the inner one for the weaving line.
  const slot = (f, right = false) => (right ? W - gutter * f : gutter * f);
  const s1 = 0.22;
  const s2 = 0.5;
  const s3 = 0.8;
  const ys = [...stops].filter((y) => y > 40 && y < H - 40).sort((a, b) => a - b);
  // The gaps between the stations, where the braids cross and the weaving line goes over.
  const gaps = ys.slice(0, -1).map((y, i) => (y + ys[i + 1]) / 2);

  /** A braid: vertical between the gaps, crossing to its other slot at each gap by two 45° moves. */
  const braid = (fa, fb, right) => {
    const xa = slot(fa, right);
    const xb = slot(fb, right);
    const d = Math.abs(xb - xa);
    const points = [[xa, 0]];
    let x = xa;
    for (const g of gaps) {
      const next = x === xa ? xb : xa;
      points.push([x, g - d / 2], [next, g + d / 2]);
      x = next;
    }
    points.push([x, H]);
    return points;
  };

  /** The weaving line: down an inner slot, over the page at every gap (45° corners), down the other side, to the foot. */
  const weave = () => {
    const r = Math.min(26, gutter * 0.3);
    let right = false;
    const points = [[slot(s3), 0]];
    gaps.forEach((g) => {
      const from = slot(s3, right);
      const to = slot(s3, !right);
      const dir = right ? -1 : 1;
      points.push([from, g - r], [from + dir * r, g], [to - dir * r, g], [to, g + r]);
      right = !right;
    });
    points.push([slot(s3, right), H]);
    return points;
  };

  const lines = [
    { id: "a", tone: "info", ...pathOf(braid(s1, s2, false)) },
    { id: "b", tone: "violet", ...pathOf(braid(s2, s1, false)) },
    { id: "c", tone: "success", ...pathOf(braid(s1, s2, true)) },
    { id: "d", tone: "warning", ...pathOf(braid(s2, s1, true)) },
    { id: "e", tone: "pink", ...pathOf(weave()) },
  ];
  // A station on each braid at each stop (where it runs vertically), the hubs where the weaving line meets a margin.
  const xAt = (points, y) => {
    for (let i = 1; i < points.length; i++) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      if (y >= Math.min(y0, y1) && y <= Math.max(y0, y1) && y1 !== y0) return x0 + ((x1 - x0) * (y - y0)) / (y1 - y0);
    }
    return points[points.length - 1][0];
  };
  const stations = [];
  for (const y of ys) {
    for (const l of lines.slice(0, 4)) stations.push({ x: xAt(l.points, y), y, tone: l.tone, hub: false });
  }
  // Where the weaving line leaves a margin and where it reaches the other one.
  for (const g of gaps) stations.push({ x: slot(s3), y: g, tone: "pink", hub: true }, { x: slot(s3, true), y: g, tone: "pink", hub: true });
  return { width: W, height: H, gutter, lines, stations };
}

/**
 * The windows of ink the lit drawing shows through, in the page's coordinates: the head with its fade, then every
 * `data-ink` section. Pure, so it is tested: { top, bottom, fade } each, `fade` the height over which the window
 * dissolves at its foot (0: a sharp edge).
 */
export function litWindows({ head = 0, bands = [] }) {
  const out = [];
  if (head > 0) out.push({ top: 0, bottom: head + HEAD_FADE, fade: HEAD_FADE });
  for (const b of bands) if (b && b.bottom > b.top) out.push({ top: b.top, bottom: b.bottom, fade: 0 });
  return out;
}

/**
 * The layer, under Home's content and over the ink: sticky to the view, as tall as it, taking no room (`marginBottom`
 * its own height). It measures Home's root — its own parent, read from its own element (a parent's ref is attached
 * only after its children's layout effects ran) — and listens to the root's parent, which scrolls.
 */
export default function NetworkBackdrop({ reduced = false }) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const brand = theme.palette.brand;
  const layerRef = useRef(null);
  const svgRef = useRef(null);
  const mapRef = useRef(null);
  const litRef = useRef(null);
  // One mask window per ink window: its rect, and the gradient of the fading one.
  const windowRefs = useRef([]);
  const [box, setBox] = useState({ width: 0, view: 0, height: 0, stops: [], head: 0, bands: [] });
  // The map follows the scroll at PARALLAX of its speed; with « reduce motion », with the page.
  const k = reduced ? 1 : PARALLAX;

  // Measure the page: its width, the view's height, the map's height, the head's foot, the ink bands and the stations
  // (the sections' headings, and the page's foot so that the lines link the elements down to the bottom).
  useLayoutEffect(() => {
    const root = layerRef.current?.parentElement;
    if (!root) return undefined;
    const scroller = root.parentElement;
    const measure = () => {
      const view = scroller?.clientHeight || window.innerHeight || 800;
      const page = root.scrollHeight;
      const top = root.getBoundingClientRect().top;
      const heads = [...root.querySelectorAll('[data-testid="home-modify"], section[data-testid^="learn-"]')].map((el) => el.getBoundingClientRect().top - top + 40);
      const hero = root.querySelector('[data-testid="home-hero"]');
      const head = hero ? hero.getBoundingClientRect().bottom - top : 0;
      const bands = [...root.querySelectorAll("[data-ink]")].map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top - top, bottom: r.bottom - top };
      });
      // A heading at a third of the view meets its station: the map's y for a page's y.
      const toMap = (y) => y - (1 - k) * Math.max(0, y - view / 3);
      const stops = [...heads, page - 90].map(toMap);
      const height = Math.max(0, page - view) * k + view;
      const width = root.clientWidth;
      const bandsKey = bands.map((b) => `${Math.round(b.top)}:${Math.round(b.bottom)}`).join();
      setBox((b) => (b.width === width && b.view === view && b.height === height && b.head === head && b.stops.join() === stops.join() && b.bands.map((x) => `${Math.round(x.top)}:${Math.round(x.bottom)}`).join() === bandsKey ? b : { width, view, height, stops, head, bands }));
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(root);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [k]);

  const windows = useMemo(() => litWindows({ head: box.head, bands: box.bands }), [box.head, box.bands]);

  // The scroll: the map moves at k of it (once a frame, straight to the layer), the lit windows follow the page.
  useEffect(() => {
    const scroller = layerRef.current?.parentElement?.parentElement;
    if (!scroller) return undefined;
    let frame = 0;
    const apply = () => {
      frame = 0;
      const y = scroller.scrollTop;
      const shift = `translate3d(0, ${-y * k}px, 0)`;
      if (mapRef.current) mapRef.current.style.transform = shift;
      if (litRef.current) litRef.current.style.transform = shift;
      windows.forEach((w, i) => {
        const refs = windowRefs.current[i];
        if (!refs?.rect) return;
        refs.rect.setAttribute("y", String(w.top - y));
        if (refs.grad) {
          refs.grad.setAttribute("y1", String(w.bottom - w.fade - y));
          refs.grad.setAttribute("y2", String(w.bottom - y));
        }
      });
    };
    apply();
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [k, box, windows]);

  // The vehicles rest while the tab is hidden.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof svg.pauseAnimations !== "function") return undefined;
    const sync = () => (document.hidden ? svg.pauseAnimations() : svg.unpauseAnimations());
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [box]);

  const map = useMemo(() => (box.width ? backdropNetwork({ width: box.width, height: box.height, stops: box.stops }) : null), [box]);
  // Under the paper, one tone: the brand's blue, a watermark. Over the ink, the brand's colours, lit.
  const mono = theme.palette.primary.main;
  const lineAlpha = dark ? 0.13 : 0.09;
  const stationAlpha = dark ? 0.45 : 0.35;
  const litAlpha = dark ? 0.5 : 0.6;
  const g = map?.gutter || 0;
  const mask = map ? `linear-gradient(90deg, #000 0px, #000 ${g}px, rgba(0,0,0,${CENTER_ALPHA}) ${g + 90}px, rgba(0,0,0,${CENTER_ALPHA}) ${box.width - g - 90}px, #000 ${box.width - g}px, #000 100%)` : "none";

  /** The vehicles of a line: three a line, a third of a run apart, starting at different points so the map is alive at once. */
  const vehicles = (l, i, color, strong) =>
    [0, 1 / 3, 2 / 3].map((phase) => {
      const dur = Math.max(30, l.length / SPEED);
      return (
        <g key={`v${l.id}${phase}`}>
          <circle r="9" fill={color} opacity={strong ? 0.22 : 0.12} filter="url(#backdrop-glow)" />
          <circle r="4.5" fill={color} opacity={strong ? 0.9 : 0.55} />
          <circle r="1.8" fill="#fff" opacity={strong ? 0.95 : 0.8} />
          <animateMotion dur={`${round(dur)}s`} begin={`-${round(dur * (phase + i * 0.13))}s`} repeatCount="indefinite" path={l.d} />
        </g>
      );
    });

  return (
    <Box ref={layerRef} aria-hidden data-testid="home-backdrop" sx={{ position: "sticky", top: 0, height: box.view || "100vh", mb: box.view ? `-${box.view}px` : "-100vh", flexShrink: 0, zIndex: 1, overflow: "hidden", pointerEvents: "none", WebkitMaskImage: mask, maskImage: mask }}>
      {map && (
        <Box component="svg" ref={svgRef} width={box.width} height={box.view} viewBox={`0 0 ${box.width} ${box.view}`} focusable="false" sx={{ display: "block" }}>
          <defs>
            <filter id="backdrop-glow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="2.5" />
            </filter>
            {/* The ink windows, where they are in the view: the lit drawing shows only there, fading with the head's blue. */}
            {windows.map((w, i) =>
              w.fade > 0 ? (
                <linearGradient key={`wg${i}`} id={`backdrop-window-fade-${i}`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={w.bottom - w.fade} y2={w.bottom} ref={(el) => { windowRefs.current[i] = { ...(windowRefs.current[i] || {}), grad: el }; }}>
                  <stop offset="0" stopColor="#fff" />
                  <stop offset="1" stopColor="#000" />
                </linearGradient>
              ) : null,
            )}
            <mask id="backdrop-lit" maskUnits="userSpaceOnUse" x="0" y="0" width={box.width} height={box.view}>
              {windows.map((w, i) => (
                <rect key={`wr${i}`} x="0" y={w.top} width={box.width} height={w.bottom - w.top} fill={w.fade > 0 ? `url(#backdrop-window-fade-${i})` : "#fff"} ref={(el) => { windowRefs.current[i] = { ...(windowRefs.current[i] || {}), rect: el }; }} />
              ))}
            </mask>
          </defs>
          {/* Under the paper: the same map in one faint tone, its stations, its vehicles. */}
          <g ref={mapRef} style={{ willChange: "transform" }}>
            {map.lines.map((l) => (
              <path key={l.id} d={l.d} fill="none" stroke={mono} strokeOpacity={lineAlpha} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
            ))}
            {map.stations.map((st, i) => (
              <circle key={`s${i}`} cx={st.x} cy={st.y} r={st.hub ? 7 : 5.5} fill={theme.palette.background.default} stroke={mono} strokeOpacity={stationAlpha} strokeWidth="2.5" />
            ))}
            {!reduced && map.lines.flatMap((l, i) => vehicles(l, i, mono, false))}
          </g>
          {/* Over the ink: the lines in their colours, their vehicles bright, the stations as white nodes. */}
          {windows.length > 0 && (
            <g mask="url(#backdrop-lit)">
              <g ref={litRef} style={{ willChange: "transform" }}>
                {map.lines.map((l) => (
                  <path key={`lit${l.id}`} d={l.d} fill="none" stroke={brand[l.tone]} strokeOpacity={litAlpha} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
                ))}
                {map.stations.map((st, i) => (
                  <circle key={`ls${i}`} cx={st.x} cy={st.y} r={st.hub ? 7 : 5.5} fill={alpha("#ffffff", 0.92)} stroke={brand[st.tone]} strokeOpacity={0.9} strokeWidth="2.5" />
                ))}
                {!reduced && map.lines.flatMap((l, i) => vehicles(l, i, brand[l.tone], true))}
              </g>
            </g>
          )}
        </Box>
      )}
    </Box>
  );
}
