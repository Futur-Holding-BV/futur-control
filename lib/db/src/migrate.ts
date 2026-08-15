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
        notified_status      TEXT NOT NULL DEFAULT 'gray',
        notified_anomaly_sha TEXT,
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Additive column migration: adds notified_status if missing
    // (databases created by the first schema iteration only had status /
    //  notified_anomaly_sha / last_notified_at / updated_at).
    await client.query(`
      ALTER TABLE repo_status_snapshots
        ADD COLUMN IF NOT EXISTS notified_status TEXT NOT NULL DEFAULT 'gray'
    `);

    // Remove the obsolete last_notified_at column if it still exists from an
    // earlier schema version.  Safe because no application code reads it.
    await client.query(`
      ALTER TABLE repo_status_snapshots
        DROP COLUMN IF EXISTS last_notified_at
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
  } finally {
    client.release();
  }
}
