/**
 * Notification policy helpers.
 *
 * 1. Debounce — a problem must persist for at least MIN_PROBLEM_AGE_MS
 *    (10 minutes) before a notification goes out. Shorter blips are logged
 *    in the action log but never sent to Slack.
 *
 * 2. Quiet hours — no notifications between 22:00 and 07:15 on weekdays
 *    (Mon–Fri mornings) and between 22:00 and 09:00 on weekend mornings
 *    (Sat–Sun). What arises during the quiet window and is still open goes
 *    out as one bundled message at the first allowed moment. All times are
 *    Europe/Amsterdam, DST included (handled via Intl time-zone rules).
 */

export const MIN_PROBLEM_AGE_MS = 10 * 60 * 1000;

const TIME_ZONE = "Europe/Amsterdam";

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

interface LocalParts {
  /** Day of week: "Mon" … "Sun" (Amsterdam local). */
  weekday: string;
  /** Minutes since local midnight. */
  minutesOfDay: number;
}

export function amsterdamParts(date: Date): LocalParts {
  const parts = partsFormatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // "24" can appear for midnight with hourCycle h24 quirks; normalise.
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return { weekday: get("weekday"), minutesOfDay: hour * 60 + minute };
}

const QUIET_START_MIN = 22 * 60; // 22:00
const WEEKDAY_END_MIN = 7 * 60 + 15; // 07:15
const WEEKEND_END_MIN = 9 * 60; // 09:00

/**
 * True when notifications must be held back at this moment
 * (Europe/Amsterdam local time).
 *
 * The morning boundary belongs to the day it falls on: a Saturday morning
 * stays quiet until 09:00 even though the window started Friday evening.
 */
export function isQuietTime(date: Date = new Date()): boolean {
  const { weekday, minutesOfDay } = amsterdamParts(date);
  if (minutesOfDay >= QUIET_START_MIN) return true;
  const isWeekend = weekday === "Sat" || weekday === "Sun";
  return minutesOfDay < (isWeekend ? WEEKEND_END_MIN : WEEKDAY_END_MIN);
}
