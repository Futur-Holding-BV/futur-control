/**
 * Unit tests for the brute-force rate-limiter in auth.ts.
 *
 * Both the drizzle `db` object and the raw `pool` used by the atomic UPSERT
 * are mocked with an in-memory Map so tests run without a real Postgres
 * instance. Each test uses a unique IP string so no test depends on another's
 * side-effects.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  loginBlockedMs,
  recordFailedLogin,
  resetLoginCounter,
} from "./auth.js";

// ---------------------------------------------------------------------------
// In-memory store that acts as the login_attempts table.
// ---------------------------------------------------------------------------

type Row = { ip: string; count: number; windowStart: Date; blockedUntil: Date | null };
const store = new Map<string, Row>();

// IP captured by the eq() drizzle-orm mock — set as a side-effect so the
// db.select/delete chains know which row to operate on.
let _ip: string | null = null;

// ---------------------------------------------------------------------------
// Mock drizzle-orm operators — most are pass-throughs; eq() captures the IP.
// ---------------------------------------------------------------------------

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, val: unknown) => { _ip = val as string; return {}; },
  lt: () => ({}),
  or: () => ({}),
  isNull: () => ({}),
  and: () => ({}),
}));

// ---------------------------------------------------------------------------
// Mock @workspace/db
//
//  • db.select().from().where()  → looks up _ip in the store
//  • db.delete().where()         → removes _ip from the store (best-effort)
//  • pool.query(sql, [ip])       → simulates the atomic UPSERT in JS so the
//                                  serial test logic stays unchanged
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => {
  const WINDOW_MS = 60_000;
  const MAX_FAILURES = 5;
  const BLOCK_MS = 60_000;

  /** Simulate the ON CONFLICT UPSERT that recordFailedLogin sends to Postgres. */
  function upsert(ip: string): { count: number; blocked_until: Date | null } {
    const now = new Date();
    const entry = store.get(ip);

    let count: number;
    let windowStart: Date;

    if (!entry || now.getTime() - entry.windowStart.getTime() >= WINDOW_MS) {
      count = 1;
      windowStart = now;
    } else {
      count = entry.count + 1;
      windowStart = entry.windowStart;
    }

    const blockedUntil =
      count >= MAX_FAILURES ? new Date(now.getTime() + BLOCK_MS) : null;

    store.set(ip, { ip, count, windowStart, blockedUntil });
    return { count, blocked_until: blockedUntil };
  }

  const dbMock = {
    select: () => ({
      from: () => ({
        where: () => {
          const ip = _ip;
          const row = ip ? store.get(ip) : undefined;
          return Promise.resolve(row ? [row] : []);
        },
      }),
    }),
    delete: () => ({
      where: () => {
        const ip = _ip;
        if (ip) store.delete(ip);
        // Return a real Promise so .catch(() => {}) in auth.ts doesn't throw.
        return Promise.resolve();
      },
    }),
  };

  const poolMock = {
    query: async (_sql: string, params: unknown[]) => {
      const ip = params[0] as string;
      const row = upsert(ip);
      return { rows: [row] };
    },
  };

  return {
    db: dbMock,
    pool: poolMock,
    loginAttempts: {
      ip: "ip",
      count: "count",
      windowStart: "window_start",
      blockedUntil: "blocked_until",
    },
  };
});

// ---------------------------------------------------------------------------
// Fake timers — lets us control Date.now() deterministically.
// ---------------------------------------------------------------------------

beforeEach(() => {
  store.clear();
  _ip = null;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tick(ms: number): void {
  vi.advanceTimersByTime(ms);
}

async function failTimes(ip: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await recordFailedLogin(ip);
}

// ---------------------------------------------------------------------------
// Fresh IP — no prior attempts
// ---------------------------------------------------------------------------

describe("loginBlockedMs — fresh IP", () => {
  it("returns 0 for an IP that has never attempted a login", async () => {
    expect(await loginBlockedMs("fresh.1")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Under threshold — first MAX_FAILURES-1 failures do not block
// ---------------------------------------------------------------------------

describe("recordFailedLogin — under threshold (< 5 failures)", () => {
  it("returns 0 after the first failure", async () => {
    expect(await recordFailedLogin("under.1")).toBe(0);
  });

  it("returns 0 after the second failure", async () => {
    await failTimes("under.2", 1);
    expect(await recordFailedLogin("under.2")).toBe(0);
  });

  it("returns 0 after the third failure", async () => {
    await failTimes("under.3", 2);
    expect(await recordFailedLogin("under.3")).toBe(0);
  });

  it("returns 0 after the fourth failure", async () => {
    await failTimes("under.4", 3);
    expect(await recordFailedLogin("under.4")).toBe(0);
  });

  it("loginBlockedMs still returns 0 after four failures", async () => {
    await failTimes("under.5", 4);
    expect(await loginBlockedMs("under.5")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// At threshold — the fifth failure triggers the block
// ---------------------------------------------------------------------------

describe("recordFailedLogin — at threshold (5th failure)", () => {
  it("returns the block duration (> 0) on the 5th failure", async () => {
    await failTimes("at.1", 4);
    const blockMs = await recordFailedLogin("at.1");
    expect(blockMs).toBeGreaterThan(0);
  });

  it("loginBlockedMs reflects the block immediately after the 5th failure", async () => {
    await failTimes("at.2", 5);
    expect(await loginBlockedMs("at.2")).toBeGreaterThan(0);
  });

  it("a 6th attempt while blocked still returns a positive block duration", async () => {
    await failTimes("at.3", 5);
    const blockMs = await recordFailedLogin("at.3");
    expect(blockMs).toBeGreaterThan(0);
  });

  it("block duration is approximately 60 seconds", async () => {
    await failTimes("at.4", 4);
    const blockMs = await recordFailedLogin("at.4");
    expect(blockMs).toBeGreaterThanOrEqual(59_000);
    expect(blockMs).toBeLessThanOrEqual(60_000);
  });
});

// ---------------------------------------------------------------------------
// Block expiry — IP is free again after the lockout window
// ---------------------------------------------------------------------------

describe("loginBlockedMs — block expires after lockout window", () => {
  it("is blocked immediately after 5 failures", async () => {
    await failTimes("expiry.1", 5);
    expect(await loginBlockedMs("expiry.1")).toBeGreaterThan(0);
  });

  it("is no longer blocked after 60 seconds have passed", async () => {
    await failTimes("expiry.2", 5);
    tick(60_001);
    expect(await loginBlockedMs("expiry.2")).toBe(0);
  });

  it("decreasing block duration is reported correctly mid-block", async () => {
    await failTimes("expiry.3", 5);
    tick(30_000);
    const remaining = await loginBlockedMs("expiry.3");
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(30_000);
  });
});

// ---------------------------------------------------------------------------
// Successful login resets the counter
// ---------------------------------------------------------------------------

describe("resetLoginCounter — successful login resets state", () => {
  it("clears a partially-failed counter so the IP starts fresh", async () => {
    await failTimes("reset.1", 3);
    await resetLoginCounter("reset.1");

    expect(await loginBlockedMs("reset.1")).toBe(0);

    for (let i = 0; i < 4; i++) {
      expect(await recordFailedLogin("reset.1")).toBe(0);
    }
  });

  it("clears a fully-blocked IP", async () => {
    await failTimes("reset.2", 5);
    expect(await loginBlockedMs("reset.2")).toBeGreaterThan(0);

    await resetLoginCounter("reset.2");
    expect(await loginBlockedMs("reset.2")).toBe(0);
  });

  it("allows a full new window of failures after reset", async () => {
    await failTimes("reset.3", 5);
    await resetLoginCounter("reset.3");

    for (let i = 0; i < 4; i++) {
      expect(await recordFailedLogin("reset.3")).toBe(0);
    }
    expect(await recordFailedLogin("reset.3")).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Window reset — a new window opens after 60 s without a block
// ---------------------------------------------------------------------------

describe("window reset — counter rolls over after the window elapses", () => {
  it("allows new failures after the window expires (no block yet)", async () => {
    await failTimes("window.1", 3);
    tick(60_001);

    for (let i = 0; i < 4; i++) {
      expect(await recordFailedLogin("window.1")).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-closed — DB errors block rather than allow logins
// ---------------------------------------------------------------------------

describe("fail-closed behaviour on DB errors", () => {
  it("loginBlockedMs returns a positive block duration when the DB throws", async () => {
    // Override the db mock for this single test to throw.
    const { db } = await import("@workspace/db");
    const dbAny = db as unknown as Record<string, () => unknown>;
    const orig = dbAny["select"];
    dbAny["select"] = () => { throw new Error("DB down"); };
    try {
      expect(await loginBlockedMs("err.1")).toBeGreaterThan(0);
    } finally {
      dbAny["select"] = orig;
    }
  });

  it("recordFailedLogin returns a positive block duration when the pool throws", async () => {
    const { pool } = await import("@workspace/db");
    const poolAny = pool as unknown as Record<string, (...args: unknown[]) => unknown>;
    const orig = poolAny["query"];
    poolAny["query"] = () => { throw new Error("DB down"); };
    try {
      expect(await recordFailedLogin("err.2")).toBeGreaterThan(0);
    } finally {
      poolAny["query"] = orig;
    }
  });
});
