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

import { wasRecoveredAfterRetry, rerunForbidden, maybeAutoRetry } from "./selfheal.js";
import { findAutoRetry, logAction, updateOutcome } from "./actionlog.js";
import { latestRuns, failedRunErrorLines, failedJobNames, rerunFailedJobs } from "./github.js";

const mockFindAutoRetry = vi.mocked(findAutoRetry);
const mockLogAction = vi.mocked(logAction);
const mockUpdateOutcome = vi.mocked(updateOutcome);
const mockLatestRuns = vi.mocked(latestRuns);
const mockFailedRunErrorLines = vi.mocked(failedRunErrorLines);
const mockFailedJobNames = vi.mocked(failedJobNames);
const mockRerunFailedJobs = vi.mocked(rerunFailedJobs);

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

// ---------------------------------------------------------------------------
// rerunForbidden
// ---------------------------------------------------------------------------

describe("rerunForbidden", () => {
  it("returns true for a job named 'deploy'", () => {
    expect(rerunForbidden(["deploy"])).toBe(true);
  });

  it("returns true for a job named 'deploy-to-production'", () => {
    expect(rerunForbidden(["deploy-to-production"])).toBe(true);
  });

  it("returns true for a job named 'release'", () => {
    expect(rerunForbidden(["release"])).toBe(true);
  });

  it("returns true for a job named 'publish-package'", () => {
    expect(rerunForbidden(["publish-package"])).toBe(true);
  });

  it("returns true for a job named 'rollout'", () => {
    expect(rerunForbidden(["rollout"])).toBe(true);
  });

  it("returns true for a job named 'uitrol'", () => {
    expect(rerunForbidden(["uitrol"])).toBe(true);
  });

  it("returns true for a job named 'migrate-db'", () => {
    expect(rerunForbidden(["migrate-db"])).toBe(true);
  });

  it("returns true for a job named 'restart-service'", () => {
    expect(rerunForbidden(["restart-service"])).toBe(true);
  });

  it("returns true for a job named 'herstart'", () => {
    expect(rerunForbidden(["herstart"])).toBe(true);
  });

  it("returns true for a job named 'production'", () => {
    expect(rerunForbidden(["production"])).toBe(true);
  });

  it("returns true when any name in the list is forbidden (others are safe)", () => {
    expect(rerunForbidden(["build", "test", "deploy", "lint"])).toBe(true);
  });

  it("returns false for ordinary CI jobs (build, test, lint)", () => {
    expect(rerunForbidden(["build", "test", "lint"])).toBe(false);
  });

  it("returns false for an empty array", () => {
    expect(rerunForbidden([])).toBe(false);
  });

  it("returns false when all names are null or undefined", () => {
    expect(rerunForbidden([null, undefined])).toBe(false);
  });

  it("returns false for a safe name that contains a substring of a forbidden word (e.g. 'tester')", () => {
    expect(rerunForbidden(["unit-tester", "linter"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// maybeAutoRetry — forbidden job short-circuit
// ---------------------------------------------------------------------------

describe("maybeAutoRetry — forbidden job blocks rerun", () => {
  const repo = "fps-api";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false and never calls rerunFailedJobs when a job name is forbidden", async () => {
    mockLatestRuns.mockResolvedValue([
      { id: 99, status: "completed", conclusion: "failure", name: "CI", run_attempt: 1 },
    ] as any);
    mockFindAutoRetry.mockResolvedValue(null);
    mockFailedRunErrorLines.mockResolvedValue(["some transient network error"]);
    mockFailedJobNames.mockResolvedValue(["build", "deploy-to-production"]);

    const result = await maybeAutoRetry(repo);

    expect(result).toBe(false);
    expect(mockRerunFailedJobs).not.toHaveBeenCalled();
    expect(mockLogAction).not.toHaveBeenCalled();
  });

  it("returns false and never calls rerunFailedJobs when the workflow name itself is forbidden", async () => {
    mockLatestRuns.mockResolvedValue([
      { id: 100, status: "completed", conclusion: "failure", name: "release", run_attempt: 1 },
    ] as any);
    mockFindAutoRetry.mockResolvedValue(null);
    mockFailedRunErrorLines.mockResolvedValue(["ECONNRESET"]);
    mockFailedJobNames.mockResolvedValue(["test"]);

    const result = await maybeAutoRetry(repo);

    expect(result).toBe(false);
    expect(mockRerunFailedJobs).not.toHaveBeenCalled();
    expect(mockLogAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// maybeAutoRetry — one-retry-per-run guarantee
// ---------------------------------------------------------------------------

describe("maybeAutoRetry — one retry per run", () => {
  const repo = "fps-api";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false immediately when a pending auto-retry entry already exists for the run", async () => {
    mockLatestRuns.mockResolvedValue([
      { id: 77, status: "completed", conclusion: "failure", name: "CI", run_attempt: 1 },
    ] as any);
    mockFindAutoRetry.mockResolvedValue({
      id: 55,
      outcome: "herstart wordt gestart",
    } as any);

    const result = await maybeAutoRetry(repo);

    expect(result).toBe(false);
    // Must not attempt another rerun
    expect(mockRerunFailedJobs).not.toHaveBeenCalled();
    expect(mockLogAction).not.toHaveBeenCalled();
    // Also must not fetch error lines or job names — work is short-circuited
    expect(mockFailedRunErrorLines).not.toHaveBeenCalled();
    expect(mockFailedJobNames).not.toHaveBeenCalled();
  });

  it("returns false and settles the outcome when an existing entry is pending but the run has now concluded a second attempt", async () => {
    mockLatestRuns.mockResolvedValue([
      { id: 78, status: "completed", conclusion: "failure", name: "CI", run_attempt: 2 },
    ] as any);
    mockFindAutoRetry.mockResolvedValue({
      id: 56,
      outcome: "herstart gestart, wacht op uitkomst",
    } as any);
    mockUpdateOutcome.mockResolvedValue(undefined as any);

    const result = await maybeAutoRetry(repo);

    expect(result).toBe(false);
    expect(mockUpdateOutcome).toHaveBeenCalledWith(56, "herhaling faalde — controle blijft rood");
    expect(mockRerunFailedJobs).not.toHaveBeenCalled();
  });
});
