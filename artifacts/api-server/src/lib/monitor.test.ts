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
  } | null,
) {
  const row = snapshot
    ? { ...snapshot, lastRedNotifiedAt: snapshot.lastRedNotifiedAt ?? null }
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
    vi.mocked(listMonitoredRepos).mockResolvedValue([repoName]);
    vi.mocked(maybeAutoRetry).mockResolvedValue(false);
    vi.mocked(notifyRepoRed).mockResolvedValue(true);
    vi.mocked(notifyAnomaly).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("notifies when a new anomaly is detected (SHA not yet notified)", async () => {
    mockSnapshot({ status: "green", notifiedStatus: "green", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ anomaly: exampleAnomaly }));

    await pollAll();

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

    expect(notifyAnomaly).toHaveBeenCalledOnce();
  });

  it("does NOT advance notifiedAnomalySha when delivery fails", async () => {
    mockSnapshot({ status: "green", notifiedStatus: "green", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ anomaly: exampleAnomaly }));
    vi.mocked(notifyAnomaly).mockResolvedValue(false);

    await pollAll();

    const saved = savedSnapshot(0);
    expect(saved["notifiedAnomalySha"]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: pollAll — anomaly notification
// ---------------------------------------------------------------------------

describe("pollAll — anomaly notification", () => {
  beforeEach(() => {
    vi.mocked(listMonitoredRepos).mockResolvedValue([repoName]);
    vi.mocked(maybeAutoRetry).mockResolvedValue(false);
    vi.mocked(notifyRepoRed).mockResolvedValue(true);
    vi.mocked(notifyAnomaly).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("notifies when a new anomaly is detected (SHA not yet notified)", async () => {
    mockSnapshot({ status: "green", notifiedStatus: "green", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ anomaly: exampleAnomaly }));

    await pollAll();

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

    expect(notifyAnomaly).toHaveBeenCalledOnce();
  });

  it("does NOT advance notifiedAnomalySha when delivery fails", async () => {
    mockSnapshot({ status: "green", notifiedStatus: "green", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ anomaly: exampleAnomaly }));
    vi.mocked(notifyAnomaly).mockResolvedValue(false);

    await pollAll();

    const saved = savedSnapshot(0);
    expect(saved["notifiedAnomalySha"]).toBeNull();
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
