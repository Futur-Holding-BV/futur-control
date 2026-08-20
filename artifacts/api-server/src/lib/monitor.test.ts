/**
 * Unit tests for monitor.ts
 *
 * Covers two exported functions:
 *   gatherRepoData  — per-repo data collection (isNewRed / newAnomaly logic)
 *   pollAll         — notification dispatch and snapshot persistence
 *
 * All external dependencies are mocked:
 *   @workspace/db   → pool + db  (no real database)
 *   ./github.js     → listMonitoredRepos / repoSummary  (no real GitHub calls)
 *   ./notifications.js → notifyRepoRed / notifyMultipleReposRed / notifyAnomaly
 *                        notifyRepoRedReminder / notifyMultipleReposRedReminder
 *   ./selfheal.js   → maybeAutoRetry / settleRecovery
 *   ./logger.js     → silent logger
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any dynamic imports.
// ---------------------------------------------------------------------------

const lockClient = {
  query: vi.fn(async (text: string) => {
    if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
    return { rows: [] };
  }),
  release: vi.fn(),
};

vi.mock("@workspace/db", () => ({
  pool: { connect: vi.fn(async () => lockClient) },
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
  notifyMultipleReposRed: vi.fn(),
  notifyRepoRedReminder: vi.fn(),
  notifyMultipleReposRedReminder: vi.fn(),
  notifyAnomaly: vi.fn(),
}));

vi.mock("./selfheal.js", () => ({
  maybeAutoRetry: vi.fn(),
  settleRecovery: vi.fn(),
}));

vi.mock("./actionlog.js", () => ({
  logAction: vi.fn(async () => 1),
}));

vi.mock("./findings.js", () => ({
  openFinding: vi.fn(async () => undefined),
  resolveFinding: vi.fn(async () => undefined),
  checkPublicServices: vi.fn(async () => undefined),
  syncExpiryFindings: vi.fn(async () => undefined),
  runFindingDelivery: vi.fn(async () => undefined),
}));

vi.mock("./watchdog.js", () => ({
  recordSuccessfulMonitorRound: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks so the mocked versions are used)
// ---------------------------------------------------------------------------

import { gatherRepoData, pollAll } from "./monitor.js";
import { db } from "@workspace/db";
import { listMonitoredRepos, repoSummary } from "./github.js";
import {
  notifyRepoRed,
  notifyMultipleReposRed,
  notifyRepoRedReminder,
  notifyAnomaly,
} from "./notifications.js";
import { maybeAutoRetry } from "./selfheal.js";
import { openFinding } from "./findings.js";
import type { RepoSummary, Anomaly } from "./github.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const repoName = "fps-api";

function makeSummary(overrides: Partial<RepoSummary> = {}): RepoSummary {
  return {
    name: repoName,
    status: "green",
    staleReason: null,
    lastCommitAt: "2026-08-15T08:00:00Z",
    lastPushAt: "2026-08-15T08:00:00Z",
    lastCommitTitle: "fix: something",
    failReason: null,
    htmlUrl: "https://github.com/fps/fps-api",
    anomaly: null,
    recoveredAfterRetry: false,
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
 * Wire db.select so that loadSnapshot returns the given snapshot (or null).
 * Supports the optional lastRedNotifiedAt field added by the reminder feature.
 * Also wires db.insert for saveSnapshot.
 */
function mockSnapshot(
  snapshot: {
    status: string;
    notifiedStatus: string;
    notifiedAnomalySha: string | null;
    lastRedNotifiedAt?: Date | null;
    problemSince?: Date | null;
  } | null,
) {
  const row = snapshot
    ? {
        ...snapshot,
        lastRedNotifiedAt: snapshot.lastRedNotifiedAt ?? null,
        problemSince: snapshot.problemSince ?? null,
      }
    : null;

  const selectMock = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(row ? [row] : []),
  };
  vi.mocked(db.select).mockReturnValue(
    selectMock as unknown as ReturnType<typeof db.select>,
  );

  const insertMock = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(db.insert).mockReturnValue(
    insertMock as unknown as ReturnType<typeof db.insert>,
  );
}

/**
 * Return the values object passed to db.insert(...).values(...) for the
 * n-th insert call (0-based).
 */
function savedSnapshot(callIndex = 0): Record<string, unknown> {
  const insertResult = vi.mocked(db.insert).mock.results[callIndex]
    ?.value as { values: ReturnType<typeof vi.fn> };
  return insertResult.values.mock.calls[0]?.[0] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests: pollAll — anomaly notification
// ---------------------------------------------------------------------------

describe("pollAll — anomaly notification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T10:00:00Z")); // Monday 12:00 Amsterdam
    vi.mocked(listMonitoredRepos).mockResolvedValue([repoName]);
    vi.mocked(maybeAutoRetry).mockResolvedValue({
      holdNotification: false,
      escalationDetail: null,
    });
    vi.mocked(notifyRepoRed).mockResolvedValue(true);
    vi.mocked(notifyAnomaly).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("registers a waiting finding when a new anomaly is detected", async () => {
    mockSnapshot({ status: "green", notifiedStatus: "green", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ anomaly: exampleAnomaly }));

    await pollAll();

    expect(notifyAnomaly).not.toHaveBeenCalled();
    expect(openFinding).toHaveBeenCalledWith(expect.objectContaining({
      kind: "anomaly",
      subject: repoName,
      detail: expect.stringContaining(exampleAnomaly.fileName),
    }));
  });

  it("does NOT re-notify for an anomaly whose SHA was already notified", async () => {
    mockSnapshot({
      status: "green",
      notifiedStatus: "green",
      notifiedAnomalySha: exampleAnomaly.commitSha,
    });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ anomaly: exampleAnomaly }));

    await pollAll();

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

    await pollAll();

    expect(notifyAnomaly).not.toHaveBeenCalled();
    expect(openFinding).toHaveBeenCalledOnce();
  });

  it("advances notifiedAnomalySha after the finding is durably registered", async () => {
    mockSnapshot({ status: "green", notifiedStatus: "green", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ anomaly: exampleAnomaly }));
    vi.mocked(notifyAnomaly).mockResolvedValue(false);

    await pollAll();

    const saved = savedSnapshot(0);
    expect(saved["notifiedAnomalySha"]).toBe(exampleAnomaly.commitSha);
  });

  it("does not call notifyAnomaly when no anomaly is present", async () => {
    mockSnapshot({ status: "green", notifiedStatus: "green", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ anomaly: null }));

    await pollAll();

    expect(notifyAnomaly).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: pollAll — GitHub errors are swallowed gracefully
// ---------------------------------------------------------------------------

describe("pollAll — GitHub error handling", () => {
  beforeEach(() => {
    vi.mocked(listMonitoredRepos).mockResolvedValue([repoName]);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns without throwing when repoSummary rejects", async () => {
    vi.mocked(repoSummary).mockRejectedValue(new Error("GitHub 503"));

    await expect(pollAll()).resolves.toBeUndefined();
    expect(notifyRepoRed).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: pollAll — every monitored repo is checked in one cycle
// ---------------------------------------------------------------------------

describe("pollAll — full repo coverage", () => {
  const repos = ["repo-alpha", "repo-beta", "repo-gamma"];

  beforeEach(() => {
    vi.mocked(listMonitoredRepos).mockResolvedValue(repos);
    vi.mocked(maybeAutoRetry).mockResolvedValue({
      holdNotification: false,
      escalationDetail: null,
    });
    vi.mocked(notifyAnomaly).mockResolvedValue(true);

    // Each repo returns a green summary; snapshot returns null (first poll).
    vi.mocked(repoSummary).mockImplementation(async (name) =>
      makeSummary({ name, status: "green" }),
    );

    const selectMock = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(db.select).mockReturnValue(
      selectMock as unknown as ReturnType<typeof db.select>,
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("resolves without throwing when db.insert rejects", async () => {
    // Simulate a database write failure inside saveSnapshot.
    const insertMock = {
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockRejectedValue(new Error("DB write failed")),
    };
    vi.mocked(db.insert).mockReturnValue(
      insertMock as unknown as ReturnType<typeof db.insert>,
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("calls repoSummary exactly once for every monitored repo", async () => {
    await pollAll();

    expect(repoSummary).toHaveBeenCalledTimes(repos.length);
    for (const r of repos) {
      expect(repoSummary).toHaveBeenCalledWith(r);
    }
  });

  it("persists a snapshot for every monitored repo", async () => {
    await pollAll();

    // One db.insert per repo.
    expect(db.insert).toHaveBeenCalledTimes(repos.length);
  });
});

// ---------------------------------------------------------------------------
// Tests: pollAll — DB write failure in saveSnapshot is swallowed
// ---------------------------------------------------------------------------

describe("pollAll — saveSnapshot failure handling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  beforeEach(() => {
    vi.mocked(listMonitoredRepos).mockResolvedValue([repoName]);
    vi.mocked(maybeAutoRetry).mockResolvedValue({
      holdNotification: false,
      escalationDetail: null,
    });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "green" }));
    vi.mocked(notifyAnomaly).mockResolvedValue(true);

    const selectMock = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(db.select).mockReturnValue(
      selectMock as unknown as ReturnType<typeof db.select>,
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("resolves without throwing when db.insert rejects", async () => {
    // Simulate a database write failure inside saveSnapshot.
    const insertMock = {
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockRejectedValue(new Error("DB write failed")),
    };
    vi.mocked(db.insert).mockReturnValue(
      insertMock as unknown as ReturnType<typeof db.insert>,
    );

    await expect(pollAll()).resolves.toBeUndefined();
  });

  it("still attempts the snapshot write even when a notification was delivered", async () => {
    // Repo is red for 30 minutes (past the debounce) so a notification is sent.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T10:00:00Z")); // Monday 12:00 Amsterdam
    mockSnapshot({
      status: "red",
      notifiedStatus: "green",
      notifiedAnomalySha: null,
      problemSince: new Date(Date.now() - 30 * 60 * 1000),
    });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red" }));
    vi.mocked(notifyRepoRed).mockResolvedValue(true);

    const insertMock = {
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockRejectedValue(new Error("DB write failed")),
    };
    vi.mocked(db.insert).mockReturnValue(
      insertMock as unknown as ReturnType<typeof db.insert>,
    );

    // Must not throw even though saveSnapshot will catch and swallow the error.
    await expect(pollAll()).resolves.toBeUndefined();
    expect(notifyRepoRed).not.toHaveBeenCalled();
    expect(openFinding).toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: pollAll — advisory lock not acquired → no repos checked
// ---------------------------------------------------------------------------

describe("pollAll — advisory lock not acquired", () => {
  afterEach(() => {
    vi.resetAllMocks();
    // Restore the default lock behaviour for subsequent tests.
    lockClient.query.mockImplementation(async (text: string) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      return { rows: [] };
    });
  });

  it("does not check any repos when the advisory lock is held by another instance", async () => {
    // Simulate another instance holding the lock.
    lockClient.query.mockImplementation(async (text: string) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: false }] };
      return { rows: [] };
    });

    await pollAll();

    expect(listMonitoredRepos).not.toHaveBeenCalled();
    expect(repoSummary).not.toHaveBeenCalled();
  });

  it("does not send any notifications when the lock is not acquired", async () => {
    lockClient.query.mockImplementation(async (text: string) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: false }] };
      return { rows: [] };
    });

    await pollAll();

    expect(notifyRepoRed).not.toHaveBeenCalled();
    expect(notifyAnomaly).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: pollAll — staleness-red notification
// ---------------------------------------------------------------------------

describe("pollAll — staleness-red notification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Monday 2026-08-17 12:00 Amsterdam (10:00 UTC) — outside the quiet window.
    vi.setSystemTime(new Date("2026-08-17T10:00:00Z"));
    vi.mocked(listMonitoredRepos).mockResolvedValue([repoName]);
    vi.mocked(maybeAutoRetry).mockResolvedValue({
      holdNotification: false,
      escalationDetail: null,
    });
    vi.mocked(notifyRepoRed).mockResolvedValue(true);
    vi.mocked(notifyAnomaly).mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("registers a waiting finding when staleReason is set and does NOT auto-retry", async () => {
    // Repo has been stale-red for 30 minutes (past the 10-min debounce).
    mockSnapshot({
      status: "red",
      notifiedStatus: "none",
      notifiedAnomalySha: null,
      problemSince: new Date(Date.now() - 30 * 60 * 1000),
    });
    vi.mocked(repoSummary).mockResolvedValue(
      makeSummary({
        status: "red",
        staleReason: "laatste commit is 15 dagen oud (rode drempel: 14 dagen)",
      }),
    );

    await pollAll();

    expect(notifyRepoRed).not.toHaveBeenCalled();
    expect(openFinding).toHaveBeenCalledWith(expect.objectContaining({
      kind: "build_failed",
      subject: repoName,
    }));
    // Self-heal must be skipped — there is no failed run to rerun.
    expect(maybeAutoRetry).not.toHaveBeenCalled();
  });

  it("re-alerts when a repo goes red again after recovering to yellow", async () => {
    // ── Cycle 1: stale-red is notified ──────────────────────────────────────
    mockSnapshot({
      status: "red",
      notifiedStatus: "none",
      notifiedAnomalySha: null,
      problemSince: new Date(Date.now() - 30 * 60 * 1000),
    });
    vi.mocked(repoSummary).mockResolvedValue(
      makeSummary({
        status: "red",
        staleReason: "laatste commit is 15 dagen oud (rode drempel: 14 dagen)",
      }),
    );

    await pollAll();

    expect(notifyRepoRed).not.toHaveBeenCalled();
    expect(openFinding).toHaveBeenCalledOnce();
    // notifiedStatus must have been persisted as "red".
    const saved1 = savedSnapshot(0);
    expect(saved1["notifiedStatus"]).toBe("red");

    vi.resetAllMocks();

    // ── Cycle 2: new commit → yellow (still stale but under the red threshold)
    //    Recovery branch fires because yellow is not a problem status.
    vi.mocked(listMonitoredRepos).mockResolvedValue([repoName]);
    vi.mocked(maybeAutoRetry).mockResolvedValue({
      holdNotification: false,
      escalationDetail: null,
    });
    vi.mocked(notifyRepoRed).mockResolvedValue(true);
    vi.mocked(notifyAnomaly).mockResolvedValue(false);
    mockSnapshot({
      status: "red",
      notifiedStatus: "red",
      notifiedAnomalySha: null,
      lastRedNotifiedAt: new Date(Date.now() - 5 * 60 * 1000),
      problemSince: null,
    });
    vi.mocked(repoSummary).mockResolvedValue(
      makeSummary({
        status: "yellow",
        staleReason: "laatste commit is 8 dagen oud (gele drempel: 7 dagen)",
      }),
    );

    await pollAll();

    // No new red notification expected during recovery.
    expect(notifyRepoRed).not.toHaveBeenCalled();
    // notifiedStatus must be reset to "yellow" so the next red re-alerts.
    const saved2 = savedSnapshot(0);
    expect(saved2["notifiedStatus"]).toBe("yellow");

    vi.resetAllMocks();

    // ── Cycle 3: repo goes stale-red again → must re-alert ──────────────────
    vi.mocked(listMonitoredRepos).mockResolvedValue([repoName]);
    vi.mocked(maybeAutoRetry).mockResolvedValue({
      holdNotification: false,
      escalationDetail: null,
    });
    vi.mocked(notifyRepoRed).mockResolvedValue(true);
    vi.mocked(notifyAnomaly).mockResolvedValue(false);
    mockSnapshot({
      status: "yellow",
      notifiedStatus: "yellow",
      notifiedAnomalySha: null,
      lastRedNotifiedAt: null,
      problemSince: new Date(Date.now() - 30 * 60 * 1000),
    });
    vi.mocked(repoSummary).mockResolvedValue(
      makeSummary({
        status: "red",
        staleReason: "laatste commit is 15 dagen oud (rode drempel: 14 dagen)",
      }),
    );

    await pollAll();

    // A fresh red after recovery must open the finding again.
    expect(notifyRepoRed).not.toHaveBeenCalled();
    expect(openFinding).toHaveBeenCalledOnce();
    expect(maybeAutoRetry).not.toHaveBeenCalled();
  });
});
