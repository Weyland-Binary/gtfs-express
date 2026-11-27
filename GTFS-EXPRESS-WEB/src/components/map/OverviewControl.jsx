import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { Tooltip } from "@mui/material";
import FitScreenOutlinedIcon from "@mui/icons-material/FitScreenOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { frame } from "../../utils/mapFraming";
import { inField, inLayer } from "../../utils/typingTarget";

const PADDING = 60;

/**
 * The overview on demand, a third cell of the map's zoom bar and the key F: what is in hand shown whole, and the view
 * one came from given back by a second press as long as the map was not moved in between. `targetOf()` answers the
 * [lat, lon] to show.
 */
export default function OverviewControl({ targetOf }) {
  const map = useMap();
  const { t } = useLanguage();
  const [back, setBack] = useState(null);
  const backRef = useRef(back);
  backRef.current = back;
  const movingRef = useRef(false);
  const targetRef = useRef(targetOf);
  targetRef.current = targetOf;
  // Drawn by the zoom bar's own rules, in every theme the map is shown in.
  const host = map.zoomControl?.getContainer() || null;
  // A click on the cell is not a click on the map under it.
  const shield = useCallback((el) => {
    if (el) L.DomEvent.disableClickPropagation(el);
  }, []);

  // A move the person makes ends the way back: the view left is no longer the one before this one.
  useMapEvents({
    moveend: () => {
      if (!movingRef.current) setBack(null);
    },
  });

  const press = useCallback(() => {
    const own = (move) => {
      movingRef.current = true;
      try {
        move();
      } finally {
        movingRef.current = false;
      }
    };
    if (backRef.current) {
      const to = backRef.current;
      own(() => map.setView(to.center, to.zoom, { animate: false }));
      // A map busy zooming takes no order: the way back stays offered until it is taken.
      if (map.getZoom() === to.zoom && map.getCenter().equals(to.center)) setBack(null);
      return;
    }
    const latlngs = targetRef.current?.() || [];
    if (!latlngs.length) return;
    const from = { center: map.getCenter(), zoom: map.getZoom() };
    own(() => frame(map, latlngs, { padding: PADDING, animate: false }));
    if (map.getZoom() !== from.zoom || !map.getCenter().equals(from.center)) setBack(from);
  }, [map]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key.toLowerCase() !== "f" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const el = document.activeElement;
      if (inField(el) || inLayer(el)) return;
      e.preventDefault();
      press();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press]);

  if (!host) return null;
  const title = `${back ? t("map.overview.back") : t("map.overview")} · F`;
  return ReactDOM.createPortal(
    <Tooltip title={title} placement="right" arrow>
      {/* The zoom bar draws its cells as anchors: a button would not take its look. */}
      {/* eslint-disable-next-line jsx-a11y/anchor-is-valid */}
      <a
        ref={shield}
        href="#"
        role="button"
        aria-label={title}
        data-testid="map-overview"
        onClick={(e) => {
          e.preventDefault();
          press();
        }}
        style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <FitScreenOutlinedIcon sx={{ fontSize: 18 }} />
      </a>
    </Tooltip>,
    host,
  );
}
