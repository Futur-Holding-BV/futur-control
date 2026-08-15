/**
 * Unit tests for the monitor's status-transition detection logic.
 *
 * All external dependencies are mocked:
 *   - @workspace/db        → pool + db (no real database)
 *   - ./github.js          → repoSummary (no real GitHub calls)
 *   - ./notifications.js   → notifyRepoRed / notifyAnomaly (no real Slack calls)
 *   - ./logger.js          → silent logger
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any dynamic imports.
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => ({
  pool: {},
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
  repoStatusSnapshots: {},
}));

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("./github.js", () => ({
  listMonitoredRepos: vi.fn(),
  repoSummary: vi.fn(),
}));

vi.mock("./notifications.js", () => ({
  notifyRepoRed: vi.fn(),
  notifyAnomaly: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks so the mocked versions are used)
// ---------------------------------------------------------------------------

import { checkRepo } from "./monitor.js";
import { repoSummary } from "./github.js";
import { notifyRepoRed, notifyAnomaly } from "./notifications.js";
import { db } from "@workspace/db";
import type { RepoSummary, Anomaly } from "./github.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const repoName = "fps-api";

function makeSummary(overrides: Partial<RepoSummary> = {}): RepoSummary {
  return {
    name: repoName,
    status: "green",
    lastPushAt: "2026-08-15T08:00:00Z",
    lastCommitTitle: "fix: something",
    failReason: null,
    htmlUrl: "https://github.com/fps/fps-api",
    anomaly: null,
    ...overrides,
  };
}

const exampleAnomaly: Anomaly = {
  commitSha: "deadbeef",
  commitTitle: "chore: bulk update",
  fileName: "src/generated/big.ts",
  linesChanged: 500,
  commitUrl: "https://github.com/fps/fps-api/commit/deadbeef",
};

/**
 * Arrange the db mock so that loadSnapshot returns `snapshot` (or null).
 * The saveSnapshot call goes through db.insert(...).values(...).onConflictDoUpdate(...)
 * so we mock the full chain.
 */
function mockSnapshot(snapshot: {
  status: string;
  notifiedStatus: string;
  notifiedAnomalySha: string | null;
} | null) {
  const selectMock = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(snapshot ? [snapshot] : []),
  };
  vi.mocked(db.select).mockReturnValue(selectMock as unknown as ReturnType<typeof db.select>);

  const insertMock = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(db.insert).mockReturnValue(insertMock as unknown as ReturnType<typeof db.insert>);
}

// ---------------------------------------------------------------------------
// Tests: status transition detection
// ---------------------------------------------------------------------------

describe("checkRepo — status transition detection", () => {
  beforeEach(() => {
    vi.mocked(notifyRepoRed).mockResolvedValue(true);
    vi.mocked(notifyAnomaly).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT notify when status is red but was already notified as red (stable red)", async () => {
    mockSnapshot({ status: "red", notifiedStatus: "red", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red", failReason: "tests falen" }));

    await checkRepo(repoName);

    expect(notifyRepoRed).not.toHaveBeenCalled();
  });

  it("notifies when status transitions from green to red", async () => {
    mockSnapshot({ status: "green", notifiedStatus: "green", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red", failReason: "tests falen" }));

    await checkRepo(repoName);

    expect(notifyRepoRed).toHaveBeenCalledOnce();
    expect(notifyRepoRed).toHaveBeenCalledWith(expect.objectContaining({ name: repoName, status: "red" }));
  });

  it("notifies when status transitions from gray to red (no prior snapshot)", async () => {
    // No snapshot → notifiedStatus defaults to "gray"
    mockSnapshot(null);
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red", failReason: "build faalt" }));

    await checkRepo(repoName);

    expect(notifyRepoRed).toHaveBeenCalledOnce();
  });

  it("does NOT notify on gray status — gray is not a recovery, gray is not red", async () => {
    mockSnapshot({ status: "green", notifiedStatus: "green", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "gray" }));

    await checkRepo(repoName);

    expect(notifyRepoRed).not.toHaveBeenCalled();
  });

  it("does NOT reset notifiedStatus to green when status transitions to gray (prevents duplicate on next red)", async () => {
    // Repo was red, now gray (workflow in-progress) — notifiedStatus must stay "red"
    mockSnapshot({ status: "red", notifiedStatus: "red", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "gray" }));

    await checkRepo(repoName);

    // notifyRepoRed must NOT be called (gray is not a transition we alert on)
    expect(notifyRepoRed).not.toHaveBeenCalled();

    // Verify the snapshot is saved with notifiedStatus still "red"
    const insertMock = vi.mocked(db.insert).mock.results[0]?.value as { values: ReturnType<typeof vi.fn> };
    const savedValues = insertMock.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(savedValues["notifiedStatus"]).toBe("red");
  });

  it("resets notifiedStatus when repo recovers from red to green", async () => {
    mockSnapshot({ status: "red", notifiedStatus: "red", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "green" }));

    await checkRepo(repoName);

    expect(notifyRepoRed).not.toHaveBeenCalled();

    const insertMock = vi.mocked(db.insert).mock.results[0]?.value as { values: ReturnType<typeof vi.fn> };
    const savedValues = insertMock.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(savedValues["notifiedStatus"]).toBe("green");
  });

  it("does NOT advance notifiedStatus to red when the Slack delivery fails", async () => {
    mockSnapshot({ status: "green", notifiedStatus: "green", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red", failReason: "lint faalt" }));
    vi.mocked(notifyRepoRed).mockResolvedValue(false); // delivery failure

    await checkRepo(repoName);

    const insertMock = vi.mocked(db.insert).mock.results[0]?.value as { values: ReturnType<typeof vi.fn> };
    const savedValues = insertMock.values.mock.calls[0]?.[0] as Record<string, unknown>;
    // notifiedStatus must NOT advance — same as before (green)
    expect(savedValues["notifiedStatus"]).toBe("green");
  });
});

// ---------------------------------------------------------------------------
// Tests: anomaly detection
// ---------------------------------------------------------------------------

describe("checkRepo — anomaly notification", () => {
  beforeEach(() => {
    vi.mocked(notifyRepoRed).mockResolvedValue(true);
    vi.mocked(notifyAnomaly).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("notifies when a new anomaly is detected (SHA not yet notified)", async () => {
    mockSnapshot({ status: "green", notifiedStatus: "green", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ anomaly: exampleAnomaly }));

    await checkRepo(repoName);

    expect(notifyAnomaly).toHaveBeenCalledOnce();
    expect(notifyAnomaly).toHaveBeenCalledWith(
      repoName,
      exampleAnomaly,
      expect.any(String),
    );
  });

  it("does NOT re-notify for an anomaly whose SHA was already notified", async () => {
    mockSnapshot({
      status: "green",
      notifiedStatus: "green",
      notifiedAnomalySha: exampleAnomaly.commitSha,
    });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ anomaly: exampleAnomaly }));

    await checkRepo(repoName);

    expect(notifyAnomaly).not.toHaveBeenCalled();
  });

  it("notifies for a new anomaly SHA even when a previous SHA was already notified", async () => {
    mockSnapshot({
      status: "green",
      notifiedStatus: "green",
      notifiedAnomalySha: "old-sha",
    });
    vi.mocked(repoSummary).mockResolvedValue(
      makeSummary({ anomaly: { ...exampleAnomaly, commitSha: "new-sha" } }),
    );

    await checkRepo(repoName);

    expect(notifyAnomaly).toHaveBeenCalledOnce();
  });

  it("does NOT advance notifiedAnomalySha when delivery fails", async () => {
    mockSnapshot({ status: "green", notifiedStatus: "green", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ anomaly: exampleAnomaly }));
    vi.mocked(notifyAnomaly).mockResolvedValue(false);

    await checkRepo(repoName);

    const insertMock = vi.mocked(db.insert).mock.results[0]?.value as { values: ReturnType<typeof vi.fn> };
    const savedValues = insertMock.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(savedValues["notifiedAnomalySha"]).toBeNull();
  });

  it("does not call notifyAnomaly when no anomaly is present", async () => {
    mockSnapshot({ status: "green", notifiedStatus: "green", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ anomaly: null }));

    await checkRepo(repoName);

    expect(notifyAnomaly).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: GitHub errors are swallowed gracefully
// ---------------------------------------------------------------------------

describe("checkRepo — GitHub error handling", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns without throwing when repoSummary rejects", async () => {
    vi.mocked(repoSummary).mockRejectedValue(new Error("GitHub 503"));

    // Should not throw
    await expect(checkRepo(repoName)).resolves.toBeUndefined();
    expect(notifyRepoRed).not.toHaveBeenCalled();
  });
});
