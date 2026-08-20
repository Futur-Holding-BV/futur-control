/**
 * Independent monitor watchdog.
 *
 * Database failure mail deliberately bypasses the DB-backed outbox: when the
 * database itself is unavailable, attempting to queue there cannot help.
 */
import { pool } from "@workspace/db";
import { amsterdamParts, isQuietTime } from "./quiet.js";
import { sendMailDirect } from "./mail.js";
import { deliverImmediateFindings, openFinding, resolveFinding } from "./findings.js";
import { logger } from "./logger.js";
import { MONITOR_POLL_LOCK_KEY } from "./monitorLock.js";

const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
const STALE_HEARTBEAT_MS = 2 * 60 * 60 * 1000;
// pollAll still has to finish its measurements before it reaches delivery.
// Three watchdog intervals avoid racing that in-flight 17:00 round.
const DAILY_REPORT_MISSED_AFTER_MINUTES = 17 * 60 + 15;
let timer: ReturnType<typeof setInterval> | null = null;
let databaseAlertSent = false;
let processStartedAt = Date.now();

export async function recordSuccessfulMonitorRound(now = new Date()): Promise<void> {
  await pool.query(
    `INSERT INTO monitor_state (key, value, updated_at)
     VALUES ('monitor-heartbeat', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [now.toISOString()],
  );
}

async function sendDatabaseAlertWithoutDatabase(): Promise<void> {
  if (process.env.NOTIFICATIONS_ENABLED === "false" || databaseAlertSent) return;
  try {
    await sendMailDirect(
      "🔴 Database van het FPS-Beheercentrum is onbereikbaar",
      "De onafhankelijke waakhond kan de database niet bereiken. Controleer de databaseverbinding; de gewone bewaking kan hierdoor geen betrouwbare metingen of wachtrij bijhouden.",
    );
    databaseAlertSent = true;
  } catch (err) {
    logger.error({ err }, "Waakhond kon database-uitval niet rechtstreeks mailen");
  }
}

function amsterdamDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function isWorkday(day: string): boolean {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

function shiftCalendarDay(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function isDateKey(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

/**
 * The current workday becomes overdue at 17:15 Amsterdam. The report itself
 * is scheduled from 17:00; this grace period prevents the independent
 * watchdog from racing an in-flight monitor round.
 */
function latestDueReportDay(now: Date): string {
  const date = amsterdamDateKey(now);
  const { weekday, minutesOfDay } = amsterdamParts(now);
  let dueDay = date;
  if (
    weekday !== "Sat"
    && weekday !== "Sun"
    && minutesOfDay >= DAILY_REPORT_MISSED_AFTER_MINUTES
  ) {
    return dueDay;
  }
  do {
    dueDay = shiftCalendarDay(dueDay, -1);
  } while (!isWorkday(dueDay));
  return dueDay;
}

/** Counts missed weekday reports, stopping once a visible intervention is due. */
function missedDailyReports(
  lastDelivered: string | undefined,
  firstDue: string | undefined,
  now: Date,
): number {
  if (!isDateKey(firstDue)) return 0;
  const latestDue = latestDueReportDay(now);
  if (isDateKey(lastDelivered) && lastDelivered >= latestDue) return 0;

  let day = isDateKey(lastDelivered)
    ? shiftCalendarDay(lastDelivered, 1)
    : firstDue;
  let missed = 0;
  while (day <= latestDue && missed < 2) {
    if (isWorkday(day)) missed += 1;
    day = shiftCalendarDay(day, 1);
  }
  return missed;
}

async function monitorRoundInProgress(): Promise<boolean> {
  const client = await pool.connect();
  let acquired = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [MONITOR_POLL_LOCK_KEY],
    );
    acquired = Boolean(result.rows[0]?.acquired);
    return !acquired;
  } finally {
    if (acquired) {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [
        MONITOR_POLL_LOCK_KEY,
      ]).catch(() => {});
    }
    client.release();
  }
}

export async function runWatchdog(now = new Date()): Promise<void> {
  try {
    const result = await pool.query<{ value: string }>(
      "SELECT value FROM monitor_state WHERE key = 'monitor-heartbeat'",
    );
    if (databaseAlertSent) databaseAlertSent = false;
    await resolveFinding("self:database");

    const stored = result.rows[0]?.value;
    const lastSuccess = stored ? new Date(stored).getTime() : processStartedAt;
    if (Number.isFinite(lastSuccess) && now.getTime() - lastSuccess > STALE_HEARTBEAT_MS) {
      await openFinding({
        id: "self:heartbeat",
        kind: "monitor_unhealthy",
        subject: "achtergrondmonitor",
        title: "De bewaking heeft al twee uur geen geslaagde ronde",
        detail: "Controleer de API-server en de toegang tot GitHub en Microsoft Graph.",
      });
      // This path must not rely on pollAll: a stalled poll is exactly what the
      // heartbeat detects. Delivery has its own advisory lock for multi-instance safety.
      await deliverImmediateFindings(now);
    } else {
      await resolveFinding("self:heartbeat");
    }

    const dailyReportState = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM monitor_state
       WHERE key IN ('daily-report', 'daily-report-first-due')`,
    );
    const state = new Map(dailyReportState.rows.map((row) => [row.key, row.value]));
    const missedReports = missedDailyReports(
      state.get("daily-report"),
      state.get("daily-report-first-due"),
      now,
    );
    if (missedReports >= 2 && await monitorRoundInProgress()) return;
    if (missedReports >= 2) {
      await openFinding({
        id: "self:daily-report",
        kind: "monitor_unhealthy",
        subject: "dagbericht",
        title: "Twee werkdagberichten van de bewaking ontbreken",
        detail: "Controleer de achtergrondmonitor, de meldingskanalen en de mailaflevering. Het dagbericht is het bewijs dat de bewaking operators nog bereikt.",
      });
      // The common helper sends only findings that are configured as NU.
      await deliverImmediateFindings(now);
    } else {
      await resolveFinding("self:daily-report");
    }
  } catch (err) {
    logger.error({ err }, "Waakhond kan de database niet bereiken");
    if (!isQuietTime(now)) await sendDatabaseAlertWithoutDatabase();
  }
}

export function startWatchdog(): void {
  if (timer) return;
  processStartedAt = Date.now();
  const initial = setTimeout(() => void runWatchdog(), 15_000);
  timer = setInterval(() => void runWatchdog(), WATCHDOG_INTERVAL_MS);
  initial.unref?.();
  timer.unref?.();
  logger.info({ intervalMs: WATCHDOG_INTERVAL_MS }, "Onafhankelijke waakhond gestart");
}

export function stopWatchdog(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}