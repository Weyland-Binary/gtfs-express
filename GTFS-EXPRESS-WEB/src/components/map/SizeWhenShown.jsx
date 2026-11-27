/** A map kept mounted behind another tab had no size meanwhile: shown again, Leaflet measures it before it is painted. */
import { useLayoutEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import { useTabShown } from "../app/tabShown";

export default function SizeWhenShown() {
  const map = useMap();
  const shown = useTabShown();
  const wasShown = useRef(shown);
  useLayoutEffect(() => {
    if (shown && !wasShown.current) map.invalidateSize();
    wasShown.current = shown;
  }, [map, shown]);
  return null;
}
