/**
 * Unit tests for wasRecoveredAfterRetry in selfheal.ts
 *
 * findAutoRetry (actionlog.js) is mocked so no real DB is touched.
 * The tests verify that the badge is only earned when:
 *   - conclusion is "success"
 *   - runAttempt > 1
 *   - an auto_retry log entry exists for the run
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any dynamic imports.
// ---------------------------------------------------------------------------

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("./github.js", () => ({
  latestRuns: vi.fn(),
  failedRunErrorLines: vi.fn(),
  failedJobNames: vi.fn(),
  rerunFailedJobs: vi.fn(),
}));

vi.mock("./actionlog.js", () => ({
  logAction: vi.fn(),
  updateOutcome: vi.fn(),
  findAutoRetry: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks so the mocked versions are used)
// ---------------------------------------------------------------------------

import { wasRecoveredAfterRetry } from "./selfheal.js";
import { findAutoRetry } from "./actionlog.js";

const mockFindAutoRetry = vi.mocked(findAutoRetry);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wasRecoveredAfterRetry", () => {
  const repo = "fps-api";
  const runId = 12345;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false when findAutoRetry returns null (no auto-retry was ever started)", async () => {
    mockFindAutoRetry.mockResolvedValue(null);

    const result = await wasRecoveredAfterRetry(repo, runId, 2, "success");

    expect(result).toBe(false);
    expect(mockFindAutoRetry).toHaveBeenCalledWith(repo, runId);
  });

  it("returns true when findAutoRetry returns a log entry and run succeeded on attempt > 1", async () => {
    mockFindAutoRetry.mockResolvedValue({
      id: 42,
      outcome: "herstart gestart, wacht op uitkomst",
    });

    const result = await wasRecoveredAfterRetry(repo, runId, 2, "success");

    expect(result).toBe(true);
    expect(mockFindAutoRetry).toHaveBeenCalledWith(repo, runId);
  });

  it("returns false when conclusion is not 'success', even if a log entry exists", async () => {
    mockFindAutoRetry.mockResolvedValue({ id: 7, outcome: "herhaling faalde — controle blijft rood" });

    const result = await wasRecoveredAfterRetry(repo, runId, 2, "failure");

    expect(result).toBe(false);
    // Short-circuits before DB call
    expect(mockFindAutoRetry).not.toHaveBeenCalled();
  });

  it("returns false when conclusion is null, even if a log entry exists", async () => {
    mockFindAutoRetry.mockResolvedValue({ id: 8, outcome: "geslaagd — hersteld na herhaling" });

    const result = await wasRecoveredAfterRetry(repo, runId, 2, null);

    expect(result).toBe(false);
    expect(mockFindAutoRetry).not.toHaveBeenCalled();
  });

  it("returns false when runAttempt is 1 (first attempt — never retried)", async () => {
    mockFindAutoRetry.mockResolvedValue({ id: 9, outcome: "geslaagd — hersteld na herhaling" });

    const result = await wasRecoveredAfterRetry(repo, runId, 1, "success");

    expect(result).toBe(false);
    expect(mockFindAutoRetry).not.toHaveBeenCalled();
  });

  it("returns false when runAttempt is undefined (treated as 1 — never retried)", async () => {
    mockFindAutoRetry.mockResolvedValue({ id: 10, outcome: "geslaagd — hersteld na herhaling" });

    const result = await wasRecoveredAfterRetry(repo, runId, undefined, "success");

    expect(result).toBe(false);
    expect(mockFindAutoRetry).not.toHaveBeenCalled();
  });

  it("returns false when findAutoRetry returns null and conclusion is 'timed_out'", async () => {
    mockFindAutoRetry.mockResolvedValue(null);

    const result = await wasRecoveredAfterRetry(repo, runId, 2, "timed_out");

    expect(result).toBe(false);
    expect(mockFindAutoRetry).not.toHaveBeenCalled();
  });
});
