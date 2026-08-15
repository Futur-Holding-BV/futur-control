import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { db, pool, loginAttempts } from "@workspace/db";
import { and, eq, lt, or, isNull } from "drizzle-orm";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Brute-force protection: per-IP failed-login counter (persisted in DB)
// ---------------------------------------------------------------------------

const MAX_FAILURES = 5;
const WINDOW_MS = 60_000; // 1 minute sliding window
const BLOCK_MS = 60_000;  // lock-out duration after exceeding limit

// Used as the fail-closed sentinel: when the DB is unreachable we treat the
// IP as temporarily blocked so an outage cannot be exploited for brute-force.
const FAIL_CLOSED_MS = BLOCK_MS;

/**
 * Returns the number of milliseconds the IP is still blocked, or 0 if free.
 * Fails CLOSED: returns FAIL_CLOSED_MS when the database is unavailable so
 * that a DB outage cannot be abused for unlimited password guessing.
 */
export async function loginBlockedMs(ip: string): Promise<number> {
  try {
    const rows = await db
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.ip, ip));
    const entry = rows[0];
    if (!entry) return 0;

    const now = Date.now();

    if (entry.blockedUntil && entry.blockedUntil.getTime() > now) {
      return entry.blockedUntil.getTime() - now;
    }

    // Window has expired with no active block → clean up stale row
    if (now - entry.windowStart.getTime() >= WINDOW_MS) {
      db.delete(loginAttempts)
        .where(eq(loginAttempts.ip, ip))
        .catch(() => {/* best-effort */});
    }

    return 0;
  } catch (err) {
    logger.warn({ err }, "auth: loginBlockedMs DB-query mislukt; fail-closed");
    return FAIL_CLOSED_MS;
  }
}

/**
 * Record a failed login for the given IP.
 * Returns remaining block ms (> 0 if the IP is now blocked).
 *
 * Uses a single atomic SQL UPSERT so concurrent requests from the same IP
 * cannot race past the threshold.  Fails CLOSED on DB error.
 */
export async function recordFailedLogin(ip: string): Promise<number> {
  try {
    // One-shot UPSERT: atomically increments the counter (or starts a new
    // window) and sets blocked_until when the threshold is reached.
    // Reading `login_attempts.count` inside the ON CONFLICT clause refers to
    // the row's *current* stored value, so parallel UPSERTs increment
    // correctly without any application-layer locking.
    const result = await pool.query<{ count: number; blocked_until: Date | null }>(
      `INSERT INTO login_attempts (ip, count, window_start, blocked_until)
       VALUES ($1, 1, NOW(), NULL)
       ON CONFLICT (ip) DO UPDATE
         SET
           count = CASE
             WHEN login_attempts.window_start < NOW() - INTERVAL '${WINDOW_MS / 1000} seconds'
             THEN 1
             ELSE login_attempts.count + 1
           END,
           window_start = CASE
             WHEN login_attempts.window_start < NOW() - INTERVAL '${WINDOW_MS / 1000} seconds'
             THEN NOW()
             ELSE login_attempts.window_start
           END,
           blocked_until = CASE
             WHEN (CASE
               WHEN login_attempts.window_start < NOW() - INTERVAL '${WINDOW_MS / 1000} seconds'
               THEN 1
               ELSE login_attempts.count + 1
             END) >= ${MAX_FAILURES}
             THEN NOW() + INTERVAL '${BLOCK_MS / 1000} seconds'
             ELSE NULL
           END
       RETURNING count, blocked_until`,
      [ip],
    );

    const row = result.rows[0];
    if (!row) {
      // RETURNING produced nothing — treat as blocked (fail closed).
      logger.warn({ ip }, "auth: recordFailedLogin RETURNING was empty; fail-closed");
      return FAIL_CLOSED_MS;
    }

    if (row.blocked_until && row.blocked_until.getTime() > Date.now()) {
      return row.blocked_until.getTime() - Date.now();
    }
    return 0;
  } catch (err) {
    logger.warn({ err }, "auth: recordFailedLogin DB-query mislukt; fail-closed");
    return FAIL_CLOSED_MS;
  }
}

/** Reset the counter after a successful login. */
export async function resetLoginCounter(ip: string): Promise<void> {
  try {
    await db.delete(loginAttempts).where(eq(loginAttempts.ip, ip));
  } catch (err) {
    // Failing to clear the counter after a successful login is non-critical:
    // the row will expire naturally within WINDOW_MS.
    logger.warn({ err }, "auth: resetLoginCounter DB-query mislukt");
  }
}

/**
 * Remove rows whose block has expired (or was never set) AND whose sliding
 * window has also elapsed. Called periodically so the table stays small.
 */
export async function cleanupExpiredLoginAttempts(): Promise<void> {
  try {
    const now = new Date();
    const windowCutoff = new Date(now.getTime() - WINDOW_MS);
    await db
      .delete(loginAttempts)
      .where(
        and(
          lt(loginAttempts.windowStart, windowCutoff),
          or(
            isNull(loginAttempts.blockedUntil),
            lt(loginAttempts.blockedUntil, now),
          ),
        ),
      );
  } catch (err) {
    logger.warn({ err }, "auth: cleanupExpiredLoginAttempts mislukt");
  }
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "fps_sessie";
const SESSION_DAYS = 30;

function secret(): string | null {
  return process.env.SESSION_SECRET ?? null;
}

export function adminPassword(): string | null {
  return process.env.ADMIN_PASSWORD ?? null;
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** Token = `<expiry epoch ms>.<hmac>`, signed with SESSION_SECRET. */
export function createSessionToken(): string | null {
  const key = secret();
  if (!key) return null;
  const exp = String(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  return `${exp}.${sign(exp, key)}`;
}

export function verifySessionToken(token: string | undefined): boolean {
  const key = secret();
  if (!key || !token) return false;
  const dot = token.indexOf(".");
  if (dot === -1) return false;
  const exp = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(exp, key);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const expMs = Number(exp);
  return Number.isFinite(expMs) && expMs > Date.now();
}

export function passwordMatches(candidate: string): boolean {
  const expected = adminPassword();
  if (!expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  // Length leak is acceptable; timingSafeEqual requires equal lengths.
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  };
}

/** Fail closed: without a valid session cookie every guarded route is 401. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[
    SESSION_COOKIE
  ];
  if (verifySessionToken(token)) {
    next();
    return;
  }
  res.status(401).json({ error: "Niet ingelogd." });
}
