/**
 * Unit tests for fetchRepoDetail — recoveredAfterRetry population
 *
 * Verifies that:
 *   1. recoveredAfterRetry is true when run_attempt > 1 and wasRecoveredAfterRetry returns true.
 *   2. recoveredAfterRetry is false (and wasRecoveredAfterRetry is never called) when
 *      run_attempt is 1 — a plain first-attempt success.
 *   3. recoveredAfterRetry is false when run_attempt > 1 but wasRecoveredAfterRetry returns false
 *      (manual retry, not an auto-heal).
 *
 * All external I/O is replaced:
 *   fetch          → vi.spyOn so each test controls GitHub API responses.
 *   ./selfheal.js  → wasRecoveredAfterRetry mocked.
 *   ./staleness.js → applyStaleness / getRepoThresholds mocked (always green).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — hoisted before any imports.
// ---------------------------------------------------------------------------

vi.mock("./selfheal.js", () => ({
  wasRecoveredAfterRetry: vi.fn(),
}));

vi.mock("./staleness.js", () => ({
  getRepoThresholds: vi.fn(),
  applyStaleness: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks so the mocked versions are used)
// ---------------------------------------------------------------------------

import { repoDetail } from "./github.js";
import { wasRecoveredAfterRetry } from "./selfheal.js";
import { applyStaleness, getRepoThresholds } from "./staleness.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG = "fps-test-org";
const REPO = "fps-api";

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    name: "CI",
    display_title: "fix: something",
    status: "completed",
    conclusion: "success",
    html_url: `https://github.com/${ORG}/${REPO}/actions/runs/42`,
    updated_at: "2026-08-18T10:00:00Z",
    run_attempt: 1,
    ...overrides,
  };
}

/** Wire three fetch responses for the Promise.all inside fetchRepoDetail:
 *  repoInfo → commits → workflow runs (latestRuns).
 */
function mockGitHubFetch(run: object) {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      makeResponse({
        name: REPO,
        html_url: `https://github.com/${ORG}/${REPO}`,
        pushed_at: "2026-08-18T09:00:00Z",
        default_branch: "main",
      }),
    )
    .mockResolvedValueOnce(
      makeResponse([
        {
          sha: "abc123",
          html_url: `https://github.com/${ORG}/${REPO}/commit/abc123`,
          commit: {
            message: "fix: something",
            committer: { date: "2026-08-18T09:00:00Z" },
          },
        },
      ]),
    )
    .mockResolvedValueOnce(
      makeResponse({ workflow_runs: [run] }),
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchRepoDetail — recoveredAfterRetry", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks(); // reset call history between tests
    process.env.GITHUB_TOKEN = "test-token";
    process.env.GITHUB_ORG = ORG;

    // Staleness: always return green so we can isolate the retry logic.
    vi.mocked(getRepoThresholds).mockResolvedValue({
      staleYellowDays: 30,
      staleRedDays: 60,
    });
    vi.mocked(applyStaleness).mockReturnValue({
      status: "green",
      staleReason: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it("sets recoveredAfterRetry: true when run_attempt > 1 and wasRecoveredAfterRetry returns true", async () => {
    const run = makeRun({ run_attempt: 2 });
    mockGitHubFetch(run);
    vi.mocked(wasRecoveredAfterRetry).mockResolvedValue(true);

    const detail = await repoDetail(REPO, /* bypass= */ true);

    expect(detail.recoveredAfterRetry).toBe(true);
    expect(vi.mocked(wasRecoveredAfterRetry)).toHaveBeenCalledWith(
      REPO,
      run.id,
      run.run_attempt,
      run.conclusion,
    );
  });

  it("sets recoveredAfterRetry: false and skips wasRecoveredAfterRetry when run_attempt is 1", async () => {
    const run = makeRun({ run_attempt: 1 });
    mockGitHubFetch(run);

    const detail = await repoDetail(REPO, /* bypass= */ true);

    expect(detail.recoveredAfterRetry).toBe(false);
    expect(vi.mocked(wasRecoveredAfterRetry)).not.toHaveBeenCalled();
  });

  it("sets recoveredAfterRetry: false when run_attempt > 1 but wasRecoveredAfterRetry returns false (manual retry)", async () => {
    const run = makeRun({ id: 55, run_attempt: 3 });
    mockGitHubFetch(run);
    vi.mocked(wasRecoveredAfterRetry).mockResolvedValue(false);

    const detail = await repoDetail(REPO, /* bypass= */ true);

    expect(detail.recoveredAfterRetry).toBe(false);
  });
});
