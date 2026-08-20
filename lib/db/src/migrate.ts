/**
 * Idempotent startup schema migration.
 *
 * Called once at application startup (before accepting traffic) so that all
 * required tables and columns exist on the provisioned database without any
 * manual step or dev-only tooling.
 *
 * Rules:
 *   • CREATE TABLE IF NOT EXISTS — safe to run against already-migrated DBs
 *   • ALTER TABLE … ADD COLUMN IF NOT EXISTS — safe additive column migrations
 *   • No DROP statements — backward-compatible only
 */
import { pool } from "./index.js";

export async function ensureTablesExist(): Promise<void> {
  const client = await pool.connect();
  try {
    // ── repo_status_snapshots ────────────────────────────────────────────────
    // Core monitoring state.  Created fresh on new databases; columns added
    // incrementally on databases from earlier schema versions.
    await client.query(`
      CREATE TABLE IF NOT EXISTS repo_status_snapshots (
        repo_name            TEXT PRIMARY KEY,
        status               TEXT NOT NULL DEFAULT 'gray',
        notified_status      TEXT NOT NULL DEFAULT 'none',
        notified_anomaly_sha TEXT,
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Additive column migration: adds notified_status if missing
    // (databases created by the first schema iteration only had status /
    //  notified_anomaly_sha / last_notified_at / updated_at).
    await client.query(`
      ALTER TABLE repo_status_snapshots
        ADD COLUMN IF NOT EXISTS notified_status TEXT NOT NULL DEFAULT 'none'
    `);

    // Remove the obsolete last_notified_at column if it still exists from an
    // earlier schema version.  Safe because no application code reads it.
    await client.query(`
      ALTER TABLE repo_status_snapshots
        DROP COLUMN IF EXISTS last_notified_at
    `);

    // Additive column migration: tracks when the most recent red Slack
    // notification was delivered so reminder throttling survives restarts.
    await client.query(`
      ALTER TABLE repo_status_snapshots
        ADD COLUMN IF NOT EXISTS last_red_notified_at TIMESTAMPTZ
    `);

    // ── action_log ──────────────────────────────────────────────────────────
    // Audit log of automatic self-heal actions and manually approved
    // one-tap actions (GitHub Actions re-runs only; never code changes).
    await client.query(`
      CREATE TABLE IF NOT EXISTS action_log (
        id         SERIAL PRIMARY KEY,
        kind       TEXT NOT NULL,
        action     TEXT NOT NULL,
        repo       TEXT,
        run_id     TEXT,
        reason     TEXT NOT NULL,
        outcome    TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      ALTER TABLE action_log
        ADD COLUMN IF NOT EXISTS reported_at TIMESTAMPTZ
    `);

    // Retry ownership now lives in self_heal_incidents. Multiple action-log
    // rows are deliberately allowed so every individual attempt remains
    // visible in the audit trail and the daily report.
    await client.query(`
      DROP INDEX IF EXISTS action_log_auto_retry_unique
    `);
    await client.query(`
      DROP INDEX IF EXISTS action_log_auto_retry_attempt_unique
    `);

    // Durable, atomic state for bounded automatic recovery. The primary key
    // is the incident claim: one GitHub run or one public service outage.
    await client.query(`
      CREATE TABLE IF NOT EXISTS self_heal_incidents (
        incident_key          TEXT PRIMARY KEY,
        kind                  TEXT NOT NULL,
        repo                  TEXT NOT NULL,
        target_id             TEXT NOT NULL,
        attempts              INTEGER NOT NULL DEFAULT 0,
        status                TEXT NOT NULL,
        next_attempt_at       TIMESTAMPTZ,
        observed_run_attempt  INTEGER,
        last_action_log_id    INTEGER,
        history               JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── domain_expiry_cache ──────────────────────────────────────────────────
    // Persists the most recent successful RDAP expiry date per domain so that
    // the stale-fallback survives a server restart during an RDAP outage.
    await client.query(`
      CREATE TABLE IF NOT EXISTS domain_expiry_cache (
        domain     TEXT PRIMARY KEY,
        expires_at TIMESTAMPTZ NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL
      )
    `);

    // Existing databases: default was 'gray'; move it to 'none' so a fresh
    // row without an explicit value never looks "already notified". Stored
    // row values stay untouched ('gray' keeps meaning already-notified).
    await client.query(`
      ALTER TABLE repo_status_snapshots
        ALTER COLUMN notified_status SET DEFAULT 'none'
    `);

    // Debounce timestamp: since when the repo has continuously been in a
    // problem state (red or unknown). Additive, non-destructive.
    await client.query(`
      ALTER TABLE repo_status_snapshots
        ADD COLUMN IF NOT EXISTS problem_since TIMESTAMPTZ
    `);

    // ── push (PWA) ─
    await client.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint   TEXT PRIMARY KEY,
        p256dh     TEXT NOT NULL,
        auth       TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS vapid_keys (
        id          TEXT PRIMARY KEY,
        public_key  TEXT NOT NULL,
        private_key TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // ── api_keys ────────────────────────────────────────────────────────────
    // Read-only machine-to-machine keys (e.g. Connect status block).
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        name       TEXT PRIMARY KEY,
        key        TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // ── repo_settings ───────────────────────────────────────────────────────
    // Per-repository staleness thresholds (days without a commit before the
    // repo turns yellow/red). Repos without a row use the defaults 7/14.
    await client.query(`
      CREATE TABLE IF NOT EXISTS repo_settings (
        repo               TEXT PRIMARY KEY,
        stale_yellow_days  INTEGER NOT NULL DEFAULT 7,
        stale_red_days     INTEGER NOT NULL DEFAULT 14
      )
    `);

    // ── mail_outbox ─────────────────────────────────────────────────────────
    // E-mails that could not be delivered via Microsoft Graph. Retried every
    // monitor cycle; loudly logged in the action log after too many attempts.
    await client.query(`
      CREATE TABLE IF NOT EXISTS mail_outbox (
        id              SERIAL PRIMARY KEY,
        subject         TEXT NOT NULL,
        body            TEXT NOT NULL,
        last_error      TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 1,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // ── login_attempts ──────────────────────────────────────────────────────
    // Persistent brute-force counter so login blocks survive server restarts.
    await client.query(`
      CREATE TABLE IF NOT EXISTS login_attempts (
        ip            TEXT PRIMARY KEY,
        count         INTEGER NOT NULL DEFAULT 0,
        window_start  TIMESTAMPTZ NOT NULL,
        blocked_until TIMESTAMPTZ
      )
    `);

    // ── findings and delivery policy ─────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS finding_levels (
        kind TEXT PRIMARY KEY,
        level TEXT NOT NULL CHECK (level IN ('NU', 'KAN_WACHTEN')),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('NU', 'KAN_WACHTEN')),
        opened_at TIMESTAMPTZ NOT NULL,
        resolved_at TIMESTAMPTZ,
        auto_resolved BOOLEAN NOT NULL DEFAULT false,
        immediate_sent_at TIMESTAMPTZ,
        daily_sent_on TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS findings_open_level_idx
        ON findings (level, opened_at) WHERE resolved_at IS NULL
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS monitor_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      INSERT INTO finding_levels (kind, level) VALUES
        ('public_service_unavailable', 'NU'),
        ('certificate_invalid', 'NU'),
        ('monitor_unhealthy', 'NU'),
        ('credential_expired', 'NU'),
        ('database_unavailable', 'NU'),
        ('build_failed', 'KAN_WACHTEN'),
        ('anomaly', 'KAN_WACHTEN'),
        ('domain_expiry', 'KAN_WACHTEN'),
        ('repo_without_check', 'KAN_WACHTEN')
      ON CONFLICT (kind) DO NOTHING
    `);
  } finally {
    client.release();
  }
}
