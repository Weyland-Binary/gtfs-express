/**
 * The one place the app tells a phone from a computer. The application is made for a computer and keeps its desktop
 * layout everywhere else; a phone gets a page of its own on Home (home/MobileHome) and, before the application, a
 * screen that hands it over to a computer (app/MobileRelay). A phone is a touch screen without hover, narrow or held
 * sideways: a narrow window on a computer (a page zoomed in) is not one, and keeps the application.
 */

import { useRef } from "react";
import { useMediaQuery } from "@mui/material";

const TOUCH = "(hover: none) and (pointer: coarse)";

/** A phone: Home is its own page there. */
export const PHONE_QUERY = `${TOUCH} and (max-width: 599.95px), ${TOUCH} and (max-height: 500px)`;
/** A screen too small for the application: a phone, or a small tablet in portrait. */
export const SMALL_TOUCH_QUERY = `${TOUCH} and (max-width: 767.95px), ${TOUCH} and (max-height: 500px)`;

export const PHONE = `@media ${PHONE_QUERY}`;

// noSsr: the first render already knows the screen, so a phone never paints the desktop page first.
export const usePhone = () => useMediaQuery(PHONE_QUERY, { noSsr: true });
export const useSmallTouch = () => useMediaQuery(SMALL_TOUCH_QUERY, { noSsr: true });

/**
 * `value` as it was when `key` last changed. The relay is decided on arrival at a route: a small tablet turned
 * between portrait and landscape would otherwise swap the application for the relay and lose all it held.
 */
export const useOnArrival = (key, value) => {
  const held = useRef(null);
  if (!held.current || held.current.key !== key) held.current = { key, value };
  return held.current.value;
};

const CONTINUED_KEY = "gtfs:phone-continue";

/** Whether this tab chose the application on a phone anyway (the relay's « Continuer quand même »). */
export const phoneContinued = () => {
  try {
    return sessionStorage.getItem(CONTINUED_KEY) === "1";
  } catch {
    return false;
  }
};

export const rememberPhoneContinue = () => {
  try {
    sessionStorage.setItem(CONTINUED_KEY, "1");
  } catch {
    /* storage blocked: the choice holds for this page */
  }
};
