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

    // Guarantees "at most one automatic retry per run" even under
    // concurrent monitor cycles: the log INSERT acts as an atomic claim.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS action_log_auto_retry_unique
        ON action_log (repo, run_id)
        WHERE kind = 'auto_retry'
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
  } finally {
    client.release();
  }
}
