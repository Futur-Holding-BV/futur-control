/**
 * Unit tests for the brute-force rate-limiter in auth.ts.
 *
 * Each test uses a unique IP string and sets up all preconditions from scratch
 * so no test depends on the side-effects of any other.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  loginBlockedMs,
  recordFailedLogin,
  resetLoginCounter,
} from "./auth.js";

// ---------------------------------------------------------------------------
// Fake timers — lets us control Date.now() deterministically.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Advance fake time by `ms` milliseconds. */
function tick(ms: number): void {
  vi.advanceTimersByTime(ms);
}

/** Fail the given IP exactly `n` times (each call is independent). */
function failTimes(ip: string, n: number): void {
  for (let i = 0; i < n; i++) recordFailedLogin(ip);
}

// ---------------------------------------------------------------------------
// Fresh IP — no prior attempts
// ---------------------------------------------------------------------------

describe("loginBlockedMs — fresh IP", () => {
  it("returns 0 for an IP that has never attempted a login", () => {
    expect(loginBlockedMs("fresh.1")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Under threshold — first MAX_FAILURES-1 failures do not block
// ---------------------------------------------------------------------------

describe("recordFailedLogin — under threshold (< 5 failures)", () => {
  it("returns 0 after the first failure", () => {
    expect(recordFailedLogin("under.1")).toBe(0);
  });

  it("returns 0 after the second failure", () => {
    failTimes("under.2", 1);
    expect(recordFailedLogin("under.2")).toBe(0);
  });

  it("returns 0 after the third failure", () => {
    failTimes("under.3", 2);
    expect(recordFailedLogin("under.3")).toBe(0);
  });

  it("returns 0 after the fourth failure", () => {
    failTimes("under.4", 3);
    expect(recordFailedLogin("under.4")).toBe(0);
  });

  it("loginBlockedMs still returns 0 after four failures", () => {
    failTimes("under.5", 4);
    expect(loginBlockedMs("under.5")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// At threshold — the fifth failure triggers the block
// ---------------------------------------------------------------------------

describe("recordFailedLogin — at threshold (5th failure)", () => {
  it("returns the block duration (> 0) on the 5th failure", () => {
    failTimes("at.1", 4); // first four failures — all under threshold
    const blockMs = recordFailedLogin("at.1"); // 5th — triggers block
    expect(blockMs).toBeGreaterThan(0);
  });

  it("loginBlockedMs reflects the block immediately after the 5th failure", () => {
    failTimes("at.2", 5);
    expect(loginBlockedMs("at.2")).toBeGreaterThan(0);
  });

  it("a 6th attempt while blocked still returns a positive block duration", () => {
    failTimes("at.3", 5);
    const blockMs = recordFailedLogin("at.3"); // 6th call
    expect(blockMs).toBeGreaterThan(0);
  });

  it("block duration is approximately 60 seconds", () => {
    failTimes("at.4", 4);
    const blockMs = recordFailedLogin("at.4");
    // Allow a tiny tolerance for test execution time (none here with fake timers, but be explicit)
    expect(blockMs).toBeGreaterThanOrEqual(59_000);
    expect(blockMs).toBeLessThanOrEqual(60_000);
  });
});

// ---------------------------------------------------------------------------
// Block expiry — IP is free again after the lockout window
// ---------------------------------------------------------------------------

describe("loginBlockedMs — block expires after lockout window", () => {
  it("is blocked immediately after 5 failures", () => {
    failTimes("expiry.1", 5);
    expect(loginBlockedMs("expiry.1")).toBeGreaterThan(0);
  });

  it("is no longer blocked after 60 seconds have passed", () => {
    failTimes("expiry.2", 5);
    tick(60_001);
    expect(loginBlockedMs("expiry.2")).toBe(0);
  });

  it("decreasing block duration is reported correctly mid-block", () => {
    failTimes("expiry.3", 5);
    tick(30_000); // 30 s in — still blocked, ~30 s left
    const remaining = loginBlockedMs("expiry.3");
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(30_000);
  });
});

// ---------------------------------------------------------------------------
// Successful login resets the counter
// ---------------------------------------------------------------------------

describe("resetLoginCounter — successful login resets state", () => {
  it("clears a partially-failed counter so the IP starts fresh", () => {
    failTimes("reset.1", 3);
    resetLoginCounter("reset.1");

    expect(loginBlockedMs("reset.1")).toBe(0);

    // Should be able to accumulate 4 more failures without triggering a block
    for (let i = 0; i < 4; i++) {
      expect(recordFailedLogin("reset.1")).toBe(0);
    }
  });

  it("clears a fully-blocked IP", () => {
    failTimes("reset.2", 5);
    expect(loginBlockedMs("reset.2")).toBeGreaterThan(0);

    resetLoginCounter("reset.2");
    expect(loginBlockedMs("reset.2")).toBe(0);
  });

  it("allows a full new window of failures after reset", () => {
    failTimes("reset.3", 5); // block it
    resetLoginCounter("reset.3"); // clear

    // 4 more failures should remain under the threshold
    for (let i = 0; i < 4; i++) {
      expect(recordFailedLogin("reset.3")).toBe(0);
    }
    // The 5th failure in the new window should block again
    expect(recordFailedLogin("reset.3")).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Window reset — a new window opens after 60 s without a block
// ---------------------------------------------------------------------------

describe("window reset — counter rolls over after the window elapses", () => {
  it("allows new failures after the window expires (no block yet)", () => {
    failTimes("window.1", 3);
    tick(60_001); // window expired, no block had been set

    // Fresh window: 4 failures should stay under threshold
    for (let i = 0; i < 4; i++) {
      expect(recordFailedLogin("window.1")).toBe(0);
    }
  });
});
