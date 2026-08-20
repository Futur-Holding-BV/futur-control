/**
 * Independent monitor watchdog.
 *
 * Database failure mail deliberately bypasses the DB-backed outbox: when the
 * database itself is unavailable, attempting to queue there cannot help.
 */
import { pool } from "@workspace/db";
import { isQuietTime } from "./quiet.js";
import { sendMailDirect } from "./mail.js";
import { deliverImmediateFindings, openFinding, resolveFinding } from "./findings.js";
import { logger } from "./logger.js";

const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
const STALE_HEARTBEAT_MS = 2 * 60 * 60 * 1000;
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