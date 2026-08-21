/**
 * Central delivery policy for operator findings.
 *
 * A finding stays visible after resolving, but resolved findings are never
 * delivered. This deliberately prevents both a short outage and an automatic
 * recovery from creating unnecessary mail.
 */
import { pool } from "@workspace/db";
import { randomUUID } from "node:crypto";
import { amsterdamParts, isQuietTime } from "./quiet.js";
import {
  notifyFinding,
  notifyDailyFindings,
} from "./notifications.js";
import { logAction, markActionsReported } from "./actionlog.js";
import { logger } from "./logger.js";
import {
  unknownConnectChecks,
  type ConnectCheck,
} from "./connectCheckModel.js";
import {
  listExpiryItems,
  listTlsExpiryItems,
  type ExpiryItem,
} from "./expiry.js";
import {
  maybeAutoRestartService,
  restartRepoForHost,
  settleServiceRecovery,
} from "./selfheal.js";

export type FindingLevel = "NU" | "KAN_WACHTEN";

export interface FindingInput {
  id: string;
  kind: string;
  subject: string;
  title: string;
  detail: string;
}

export interface FindingView {
  id: string;
  kind: string;
  subject: string;
  title: string;
  detail: string;
  level: FindingLevel;
  openedAt: string;
  resolvedAt: string | null;
  autoResolved: boolean;
}

export interface FindingLevelView {
  kind: string;
  level: FindingLevel;
}

interface FindingRow extends FindingInput {
  level: FindingLevel;
  opened_at: Date;
  resolved_at: Date | null;
  auto_resolved: boolean;
  immediate_sent_at: Date | null;
}

const FALLBACK_LEVELS: Record<string, FindingLevel> = {
  public_service_unavailable: "NU",
  certificate_invalid: "NU",
  monitor_unhealthy: "NU",
  credential_expired: "NU",
  database_unavailable: "NU",
  build_failed: "KAN_WACHTEN",
  anomaly: "KAN_WACHTEN",
  domain_expiry: "KAN_WACHTEN",
  repo_without_check: "KAN_WACHTEN",
  repo_coverage_limited: "KAN_WACHTEN",
  sentry_direct: "NU",
  sentry_error: "KAN_WACHTEN",
  connect_status_unavailable: "KAN_WACHTEN",
  deployment_mismatch: "KAN_WACHTEN",
  backup_stale: "KAN_WACHTEN",
  nas_stale: "KAN_WACHTEN",
  mail_inactive: "KAN_WACHTEN",
};

const IMMEDIATE_DELIVERY_LOCK = "6839201476";
const DAILY_REPORT_CHECK_INTERVAL_MS = 30_000;

interface FindingDbClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
  release(): void;
}

async function levelFor(kind: string): Promise<FindingLevel> {
  const result = await pool.query<{ level: FindingLevel }>(
    "SELECT level FROM finding_levels WHERE kind = $1",
    [kind],
  );
  return result.rows[0]?.level ?? FALLBACK_LEVELS[kind] ?? "KAN_WACHTEN";
}

/** Opens or refreshes a finding. Policy changes are picked up on every run. */
export async function openFinding(input: FindingInput): Promise<void> {
  const level = await levelFor(input.kind);
  await pool.query(
    `INSERT INTO findings
       (id, kind, subject, title, detail, level, opened_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,now(),now())
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title, detail = EXCLUDED.detail, level = EXCLUDED.level,
       opened_at = CASE WHEN findings.resolved_at IS NULL THEN findings.opened_at ELSE now() END,
       resolved_at = NULL, auto_resolved = false,
       immediate_sent_at = CASE WHEN findings.resolved_at IS NULL THEN findings.immediate_sent_at ELSE NULL END,
        immediate_claim_token = CASE WHEN findings.resolved_at IS NULL THEN findings.immediate_claim_token ELSE NULL END,
       daily_sent_on = CASE WHEN findings.resolved_at IS NULL THEN findings.daily_sent_on ELSE NULL END,
       updated_at = now()`,
    [input.id, input.kind, input.subject, input.title, input.detail, level],
  );
}

/** Marks a finding as automatically resolved; it remains in the audit trail only. */
export async function resolveFinding(id: string): Promise<void> {
  const result = await pool.query(
    `UPDATE findings SET resolved_at = now(), auto_resolved = true, updated_at = now()
     WHERE id = $1 AND resolved_at IS NULL`,
    [id],
  );
  if (result.rowCount) {
    await logAction({
      kind: "bevinding_opgelost",
      action: "Bevinding vanzelf opgelost",
      reason: "De bewaking meet weer een gezonde situatie; er is geen melding verstuurd.",
      outcome: id,
    });
  }
}

/** Gives callers the configured delivery level without duplicating DB policy. */
export async function findingLevel(kind: string): Promise<FindingLevel> {
  return levelFor(kind);
}

export async function listFindings(): Promise<FindingView[]> {
  const result = await pool.query<FindingRow>(
    `SELECT id, kind, subject, title, detail, level, opened_at, resolved_at,
            auto_resolved, immediate_sent_at
       FROM findings
      ORDER BY (resolved_at IS NULL) DESC, opened_at DESC
      LIMIT 200`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    title: row.title,
    detail: row.detail,
    level: row.level,
    openedAt: row.opened_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    autoResolved: row.auto_resolved,
  }));
}

export async function listFindingLevels(): Promise<FindingLevelView[]> {
  const result = await pool.query<FindingLevelView>(
    "SELECT kind, level FROM finding_levels ORDER BY kind",
  );
  return result.rows;
}

export async function updateFindingLevel(
  kind: string,
  level: FindingLevel,
): Promise<FindingLevelView | null> {
  const result = await pool.query<FindingLevelView>(
    `UPDATE finding_levels SET level = $2, updated_at = now()
      WHERE kind = $1 RETURNING kind, level`,
    [kind, level],
  );
  const updated = result.rows[0] ?? null;
  if (updated) {
    await pool.query(
      "UPDATE findings SET level = $2, updated_at = now() WHERE kind = $1 AND resolved_at IS NULL",
      [kind, level],
    );
  }
  return updated;
}

export async function deliverImmediateFindings(now = new Date()): Promise<void> {
  if (isQuietTime(now)) return;
  const client = (await pool.connect()) as unknown as FindingDbClient;
  let locked = false;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [IMMEDIATE_DELIVERY_LOCK],
    );
    locked = Boolean(lock.rows[0]?.acquired);
    if (!locked) return;

    const rows = await client.query<FindingRow & Record<string, unknown>>(
      `SELECT id, kind, subject, title, detail, level, opened_at, resolved_at,
              auto_resolved, immediate_sent_at
         FROM findings
        WHERE resolved_at IS NULL AND auto_resolved = false
          AND level = 'NU' AND immediate_sent_at IS NULL
        ORDER BY opened_at`,
    );
    for (const finding of rows.rows) {
      // Claim before crossing the network boundary. Two processes — or a
      // process restart immediately after Graph accepted a message — must
      // never emit the same finding twice.
      const claimToken = randomUUID();
      const claim = await client.query<{ id: string }>(
        `UPDATE findings
            SET immediate_claim_token = $2, updated_at = now()
          WHERE id = $1 AND immediate_sent_at IS NULL
            AND immediate_claim_token IS NULL
        RETURNING id`,
        [finding.id, claimToken],
      );
      if (!claim.rows[0]) continue;

      let delivered = false;
      try {
        delivered = await notifyFinding(finding.title, finding.detail, "NU");
      } catch (err) {
        logger.error({ err, findingId: finding.id }, "Directe bevinding versturen mislukt");
      }
      if (delivered) {
        await client.query(
          `UPDATE findings
              SET immediate_sent_at = now(), immediate_claim_token = NULL,
                  updated_at = now()
            WHERE id = $1 AND immediate_claim_token = $2`,
          [finding.id, claimToken],
        );
      } else {
        // No channel accepted or durably queued the message. Release only our
        // own claim so a later round may retry it.
        await client.query(
          `UPDATE findings
              SET immediate_claim_token = NULL, updated_at = now()
            WHERE id = $1 AND immediate_claim_token = $2`,
          [finding.id, claimToken],
        );
      }
    }
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [
        IMMEDIATE_DELIVERY_LOCK,
      ]).catch(() => {});
    }
    client.release();
  }
}

function localDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

/**
 * Sends at most one weekday 17:00 report, including all server actions that day.
 * A successful delivery is the proof that monitoring is still reaching operators.
 */
export async function deliverDailyReport(now = new Date()): Promise<void> {
  const { weekday, minutesOfDay } = amsterdamParts(now);
  if (weekday === "Sat" || weekday === "Sun" || minutesOfDay < 17 * 60) return;
  const day = localDateKey(now);
  const previous = await pool.query<{ value: string }>(
    "SELECT value FROM monitor_state WHERE key = 'daily-report'",
  );
  if (previous.rows[0]?.value === day) return;
  const pending = await pool.query<{ value: string }>(
    "SELECT value FROM monitor_state WHERE key = 'daily-report-pending'",
  );
  if (pending.rows[0]?.value === day) return;

  // Keep the first due date even when every delivery channel fails. The
  // independent watchdog uses it to expose an initial series of missed
  // reports, before there is a first successful daily-report marker.
  await pool.query(
    `INSERT INTO monitor_state (key, value, updated_at) VALUES ('daily-report-first-due', $1, now())
     ON CONFLICT (key) DO NOTHING`,
    [day],
  );

  // One atomic day claim, persisted before any channel is called. This
  // protects against concurrent processes and against a restart in the small
  // window after Graph accepted the message but before the success marker.
  const claim = await pool.query<{ value: string }>(
    `INSERT INTO monitor_state (key, value, updated_at)
     VALUES ('daily-report-claim', $1, now())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = now()
       WHERE monitor_state.value <> EXCLUDED.value
     RETURNING value`,
    [day],
  );
  if (!claim.rowCount) return;

  let deliveryHandled = false;
  try {
    const rows = await pool.query<FindingRow>(
      `SELECT id, kind, subject, title, detail, level, opened_at, resolved_at,
              auto_resolved, immediate_sent_at
         FROM findings
        WHERE resolved_at IS NULL AND auto_resolved = false
        ORDER BY opened_at`,
    );
    const actions = await pool.query<{
      id: number;
      action: string;
      repo: string | null;
      outcome: string;
    }>(
      `SELECT id, action, repo, outcome FROM action_log
        WHERE reported_at IS NULL
          AND kind IN ('auto_retry', 'auto_restart', 'manual_rerun')
        ORDER BY created_at`,
    );
    const operationalState = await pool.query<{ value: string }>(
      "SELECT value FROM monitor_state WHERE key = 'connect:status:checks'",
    );
    let operationalChecks: ConnectCheck[] = unknownConnectChecks();
    try {
      const parsed = JSON.parse(operationalState.rows[0]?.value ?? "");
      if (
        Array.isArray(parsed)
        && parsed.length === 5
        && parsed.every(
          (check) =>
            check
            && typeof check === "object"
            && typeof check.id === "string"
            && typeof check.label === "string"
            && ["ok", "warning", "error", "unknown"].includes(check.status)
            && typeof check.detail === "string",
        )
      ) {
        operationalChecks = parsed as ConnectCheck[];
      }
    } catch {
      // De vaste onbekend-resultaten houden het dagbericht exact vijfledig.
    }
    const delivery = await notifyDailyFindings(
      rows.rows.map((r) => ({
        title: r.title,
        detail: r.detail,
        kind: r.kind,
      })),
      actions.rows.map(({ action, repo, outcome }) => ({ action, repo, outcome })),
      day,
      operationalChecks,
    );
    deliveryHandled = delivery.handled;
    if (delivery.handled) {
      await markActionsReported(actions.rows.map((action) => action.id));
      await pool.query(
        `UPDATE findings SET daily_sent_on = $1, updated_at = now()
         WHERE resolved_at IS NULL AND auto_resolved = false`,
        [day],
      );
    }
    if (delivery.confirmed) {
      await pool.query(
        `INSERT INTO monitor_state (key, value, updated_at) VALUES ('daily-report', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [day],
      );
    } else if (delivery.handled) {
      // A mail in the durable outbox is handled (so it must not be queued
      // again), but it is not proof of delivery until Graph accepts its retry.
      await pool.query(
        `INSERT INTO monitor_state (key, value, updated_at) VALUES ('daily-report-pending', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [day],
      );
    } else {
      // Nothing was sent or durably queued. Releasing this exact day's claim is
      // safe: a later scheduler tick may try again without duplicating mail.
      await pool.query(
        "DELETE FROM monitor_state WHERE key = 'daily-report-claim' AND value = $1",
        [day],
      );
    }
  } catch (err) {
    // Before any channel handled the report, a DB/provider error is safely
    // retryable. Once handled, retain the claim: retrying could duplicate a
    // report Graph already accepted.
    if (!deliveryHandled) {
      await pool.query(
        "DELETE FROM monitor_state WHERE key = 'daily-report-claim' AND value = $1",
        [day],
      ).catch(() => {});
    }
    throw err;
  }
}

export async function runFindingDelivery(now = new Date()): Promise<void> {
  try {
    await deliverImmediateFindings(now);
    await deliverDailyReport(now);
  } catch (err) {
    logger.error({ err }, "Bevindingen afleveren mislukt");
  }
}

let dailyReportInitialTimer: ReturnType<typeof setTimeout> | null = null;
let dailyReportTimer: ReturnType<typeof setInterval> | null = null;

/** Milliseconds to the next wall-clock-aligned delivery check. */
export function millisecondsUntilNextDailyReportCheck(
  nowMs: number,
  intervalMs = DAILY_REPORT_CHECK_INTERVAL_MS,
): number {
  return intervalMs - (nowMs % intervalMs);
}

/**
 * Runs the 17:00 Amsterdam report independently from the slow repository poll.
 * The gate in deliverDailyReport still decides whether today is due; this
 * timer merely bounds scheduling jitter to 30 seconds.
 */
export function startDailyReportScheduler(): void {
  if (dailyReportInitialTimer || dailyReportTimer) return;
  const delay = millisecondsUntilNextDailyReportCheck(Date.now());
  dailyReportInitialTimer = setTimeout(() => {
    dailyReportInitialTimer = null;
    runScheduledDailyReport();
    dailyReportTimer = setInterval(
      runScheduledDailyReport,
      DAILY_REPORT_CHECK_INTERVAL_MS,
    );
    dailyReportTimer.unref?.();
  }, delay);
  dailyReportInitialTimer.unref?.();
  logger.info(
    { intervalMs: DAILY_REPORT_CHECK_INTERVAL_MS },
    "Onafhankelijke dagberichtklok gestart (Europe/Amsterdam)",
  );
}

function runScheduledDailyReport(): void {
  void deliverDailyReport().catch((err) => {
    logger.error({ err }, "Dagberichtklok kon de aflevering niet uitvoeren");
  });
}

export function stopDailyReportScheduler(): void {
  if (dailyReportInitialTimer) clearTimeout(dailyReportInitialTimer);
  if (dailyReportTimer) clearInterval(dailyReportTimer);
  dailyReportInitialTimer = null;
  dailyReportTimer = null;
}

type HttpsFailureKind = "certificate" | "service";

interface HttpsProbeResult {
  ok: boolean;
  failureKind?: HttpsFailureKind;
  reason?: string;
}

const CERTIFICATE_ERROR_CODES = new Set([
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function httpsErrorParts(err: unknown): { code: string; message: string } {
  const error = err as {
    code?: unknown;
    message?: unknown;
    cause?: { code?: unknown; message?: unknown };
  };
  return {
    code: String(error.cause?.code ?? error.code ?? ""),
    message: String(error.cause?.message ?? error.message ?? "onbekende fout"),
  };
}

async function probeHttps(entry: string): Promise<HttpsProbeResult> {
  try {
    const response = await fetch(`https://${entry}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status < 500) return { ok: true };
    return {
      ok: false,
      failureKind: "service",
      reason: `De dienst reageert, maar geeft HTTP-status ${response.status}.`,
    };
  } catch (err) {
    const { code, message } = httpsErrorParts(err);
    if (CERTIFICATE_ERROR_CODES.has(code)) {
      return {
        ok: false,
        failureKind: "certificate",
        reason: `De dienst reageert, maar de TLS-controle faalt: ${message}`,
      };
    }
    const reason =
      code === "ECONNREFUSED"
        ? "De dienst draait niet of poort 443 luistert niet: de verbinding wordt geweigerd."
        : code === "ENOTFOUND"
          ? "De hostnaam bestaat niet in DNS."
          : code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT"
            ? "De dienst reageert niet binnen tien seconden."
            : `De HTTPS-verbinding mislukt: ${message}`;
    return { ok: false, failureKind: "service", reason };
  }
}

/** Check public HTTPS hosts; a finding only opens after three failed polls. */
export async function checkPublicServices(now = new Date()): Promise<void> {
  const hosts = new Set(
    (process.env.EXPIRY_TLS_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
  );
  try {
    const connectUrl = new URL(process.env.CONNECT_STATUS_URL ?? "");
    if (connectUrl.protocol === "https:") hosts.add(connectUrl.host);
  } catch {
    // De Connect-contractcontrole maakt een ongeldige configuratie zichtbaar.
  }
  for (const entry of hosts) {
    const host = entry.split(":")[0]!;
    const stateKey = `availability:${entry}`;
    const probe = await probeHttps(entry);
    if (probe.ok) {
      const restartRepo = restartRepoForHost(host);
      if (restartRepo) {
        await settleServiceRecovery(host, restartRepo);
      }
      await pool.query(
        `INSERT INTO monitor_state (key, value, updated_at) VALUES ($1, '0', now())
         ON CONFLICT (key) DO UPDATE SET value = '0', updated_at = now()`,
        [stateKey],
      );
      await resolveFinding(`public-service:${entry}`);
      continue;
    }
    if (probe.failureKind === "certificate") {
      // syncExpiryFindings owns certificate incidents. Reset the availability
      // debounce and close any older generic outage finding so one broken
      // certificate produces one direct message with one precise cause.
      await pool.query(
        `INSERT INTO monitor_state (key, value, updated_at) VALUES ($1, '0', now())
         ON CONFLICT (key) DO UPDATE SET value = '0', updated_at = now()`,
        [stateKey],
      );
      await resolveFinding(`public-service:${entry}`);
      await openFinding({
        id: `expiry:tls:${entry}`,
        kind: "certificate_invalid",
        subject: `tls:${entry}`,
        title: `TLS-certificaat ${host} is ongeldig`,
        detail: probe.reason ?? "De dienst draait, maar de TLS-controle faalt.",
      });
      continue;
    }
    const previous = await pool.query<{ value: string }>(
      "SELECT value FROM monitor_state WHERE key = $1", [stateKey],
    );
    let state: { count: number; firstAt: number; reason: string };
    try {
      const parsed = JSON.parse(previous.rows[0]?.value ?? "") as Partial<typeof state>;
      state = {
        count: Math.min(3, Number(parsed.count ?? 0) + 1),
        firstAt: Number(parsed.firstAt ?? now.getTime()),
        reason: probe.reason ?? "De oorzaak kon niet worden bepaald.",
      };
    } catch {
      state = {
        count: 1,
        firstAt: now.getTime(),
        reason: probe.reason ?? "De oorzaak kon niet worden bepaald.",
      };
    }
    await pool.query(
      `INSERT INTO monitor_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [stateKey, JSON.stringify(state)],
    );
    if (state.count >= 3 && now.getTime() - state.firstAt >= 10 * 60 * 1000) {
      const restartRepo = restartRepoForHost(host);
      const decision = restartRepo
        ? await maybeAutoRestartService({
            host,
            repo: restartRepo,
            outageStartedAt: state.firstAt,
            now,
          })
        : { holdNotification: false, escalationDetail: null };
      if (decision.holdNotification) continue;
      const detail = [
        "Drie opeenvolgende HTTPS-metingen in ongeveer tien minuten zijn mislukt.",
        `Oorzaak: ${state.reason}`,
        decision.escalationDetail,
      ]
        .filter(Boolean)
        .join("\n\n");
      await openFinding({
        id: `public-service:${entry}`, kind: "public_service_unavailable", subject: entry,
        title: `Publieke dienst ${host} is niet bereikbaar`,
        detail,
      });
    }
  }
}

/** Makes expiry issues visible in the same register as all other findings. */
export async function syncExpiryFindings(): Promise<void> {
  let items: ExpiryItem[];
  try {
    const [allItems, freshTlsItems] = await Promise.all([
      listExpiryItems(),
      listTlsExpiryItems(),
    ]);
    // TLS is operational state, not slow-changing registry metadata. Always
    // replace cached TLS entries with a fresh handshake measurement.
    items = [
      ...allItems.filter((item) => item.category !== "tls_certificate"),
      ...freshTlsItems,
    ];
  } catch (err) {
    logger.warn({ err }, "Verloopcontroles overslaan: uitlezen mislukt");
    return;
  }
  for (const item of items) {
    const certificateNow = item.category === "tls_certificate" && item.severity === "red";
    const domainWaiting = item.category === "domain" && (item.severity === "red" || item.severity === "orange");
    const credentialInvalid = (item.category === "github_token" || item.category === "azure_key")
      && (
        (item.daysLeft !== null && item.daysLeft <= 0) ||
        /ongeldig|verlopen|weigerde de aanmelding/i.test(item.unknownReason ?? "")
      );
    const id = `expiry:${item.id}`;
    if (certificateNow || domainWaiting || credentialInvalid) {
      const kind = certificateNow ? "certificate_invalid" : credentialInvalid ? "credential_expired" : "domain_expiry";
      await openFinding({
        id, kind, subject: item.id, title: item.label,
        detail: item.unknownReason ?? `Verloopt ${item.daysLeft ?? "onbekend"} dagen vanaf nu. ${item.consequence}`,
      });
    } else {
      await resolveFinding(id);
    }
  }
}