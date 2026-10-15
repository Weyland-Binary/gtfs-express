/**
 * ChangeFraming — the defaults a new operation of ③ takes from the project's
 * change (`context`): its period and, for a project that recorded them, its
 * day types.
 *
 * The change's dates are asked at ② (StepObjectives, « Mise en service »:
 * `context.from_date`, `to_date`). The kind of change and the day types are
 * not asked (a brief states them; each objective and each operation carries
 * its own days), but a project that recorded them keeps them as its
 * defaults. The operation form fills only the parameters the operation has —
 * defaults only, shown and changeable, nothing is changed behind the person.
 */

import { toIso } from "./localDates";

// The day types of the coherence report, in the glossary's order.
export const DAY_TYPES = Object.freeze(["school_weekday", "holiday_weekday", "saturday", "sunday_holiday"]);
// A day type as the engine's days and named periods (scope.js): the days it runs on, and the school period that narrows them.
const DAY_TYPE_DAYS = Object.freeze({ school_weekday: "weekday", holiday_weekday: "weekday", saturday: "saturday", sunday_holiday: "sunday" });
const DAY_TYPE_PERIOD = Object.freeze({ school_weekday: "school_days", holiday_weekday: "school_holidays" });

/**
 * The defaults the project's change proposes to a new operation, as the
 * operation's scope parameters: its period (from_date, to_date: a valid one
 * only), its days (one value, a list, or `daily` when all three kinds of day
 * are ticked) and a school period only when every day type ticked is one kind
 * of weekday — a period narrows all the operation's days, so a Saturday
 * ticked beside the school weekdays keeps no period.
 */
export const framingDefaults = (context) => {
  const from = toIso(context?.from_date || "");
  const to = toIso(context?.to_date || "");
  const out = {};
  if (from) out.from_date = from;
  if (to && (!from || to >= from)) out.to_date = to;
  const ticked = Array.isArray(context?.day_types) ? DAY_TYPES.filter((d) => context.day_types.includes(d)) : [];
  if (ticked.length) {
    const days = [...new Set(ticked.map((d) => DAY_TYPE_DAYS[d]))];
    out.days = days.length === 3 ? "daily" : days.length === 1 ? days[0] : days;
    const periods = new Set(ticked.map((d) => DAY_TYPE_PERIOD[d] || null));
    if (periods.size === 1 && !periods.has(null)) out.period = [...periods][0];
  }
  return out;
};
