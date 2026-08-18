/**
 * Unit tests for selfheal.ts — settleRecovery
 *
 * settleRecovery is called by the monitor when a repo turns green. It finds
 * the pending auto-retry log entry and marks it "geslaagd — hersteld na
 * herhaling".
 *
 * All external dependencies are mocked (no real GitHub calls, no real DB).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any dynamic imports.
// ---------------------------------------------------------------------------

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

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { settleRecovery } from "./selfheal.js";
import { latestRuns } from "./github.js";
import { findAutoRetry, updateOutcome } from "./actionlog.js";

const latestRunsMock = vi.mocked(latestRuns);
const findAutoRetryMock = vi.mocked(findAutoRetry);
const updateOutcomeMock = vi.mocked(updateOutcome);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO = "fps-api";
const RUN_ID = 9001;

function makeSuccessRun(run_attempt = 2) {
  return {
    id: RUN_ID,
    status: "completed" as const,
    conclusion: "success" as const,
    run_attempt,
    name: "CI",
    display_title: "CI run",
    html_url: "https://github.com/fps/fps-api/actions/runs/9001",
    updated_at: "2026-08-18T10:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("settleRecovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateOutcomeMock.mockResolvedValue(undefined);
  });

  it("marks the pending entry as succeeded and returns true when a retried run is green", async () => {
    latestRunsMock.mockResolvedValue([makeSuccessRun(2)]);
    findAutoRetryMock.mockResolvedValue({
      id: 42,
      outcome: "herstart gestart, wacht op uitkomst",
    });

    const result = await settleRecovery(REPO);

    expect(result).toBe(true);
    expect(findAutoRetryMock).toHaveBeenCalledWith(REPO, RUN_ID);
    expect(updateOutcomeMock).toHaveBeenCalledWith(
      42,
      "geslaagd — hersteld na herhaling",
    );
  });

  it("still returns true but skips updateOutcome when the entry already has a non-pending outcome", async () => {
    latestRunsMock.mockResolvedValue([makeSuccessRun(2)]);
    findAutoRetryMock.mockResolvedValue({
      id: 42,
      outcome: "geslaagd — hersteld na herhaling", // already settled
    });

    const result = await settleRecovery(REPO);

    expect(result).toBe(true);
    expect(updateOutcomeMock).not.toHaveBeenCalled();
  });

  it("returns false without calling updateOutcome when no log entry exists", async () => {
    latestRunsMock.mockResolvedValue([makeSuccessRun(2)]);
    findAutoRetryMock.mockResolvedValue(null);

    const result = await settleRecovery(REPO);

    expect(result).toBe(false);
    expect(updateOutcomeMock).not.toHaveBeenCalled();
  });

  it("returns false early when run_attempt is 1 (not a retry)", async () => {
    latestRunsMock.mockResolvedValue([makeSuccessRun(1)]);

    const result = await settleRecovery(REPO);

    expect(result).toBe(false);
    expect(findAutoRetryMock).not.toHaveBeenCalled();
    expect(updateOutcomeMock).not.toHaveBeenCalled();
  });

  it("returns false early when run_attempt is undefined (defaults to 1)", async () => {
    const run = { ...makeSuccessRun(1) };
    // @ts-expect-error intentionally omit run_attempt
    delete run.run_attempt;
    latestRunsMock.mockResolvedValue([run]);

    const result = await settleRecovery(REPO);

    expect(result).toBe(false);
    expect(findAutoRetryMock).not.toHaveBeenCalled();
  });

  it("returns false early when the latest run did not succeed", async () => {
    latestRunsMock.mockResolvedValue([
      { ...makeSuccessRun(2), conclusion: "failure" as const },
    ]);

    const result = await settleRecovery(REPO);

    expect(result).toBe(false);
    expect(findAutoRetryMock).not.toHaveBeenCalled();
  });

  it("returns false when latestRuns returns an empty array", async () => {
    latestRunsMock.mockResolvedValue([]);

    const result = await settleRecovery(REPO);

    expect(result).toBe(false);
    expect(findAutoRetryMock).not.toHaveBeenCalled();
  });

  it("returns false when latestRuns throws", async () => {
    latestRunsMock.mockRejectedValue(new Error("GitHub unreachable"));

    const result = await settleRecovery(REPO);

    expect(result).toBe(false);
    expect(findAutoRetryMock).not.toHaveBeenCalled();
    expect(updateOutcomeMock).not.toHaveBeenCalled();
  });
});
