/**
 * Unit tests for the monitor's status-transition and reminder detection logic.
 *
 * All external dependencies are mocked:
 *   - @workspace/db        → pool + db (no real database)
 *   - ./github.js          → repoSummary (no real GitHub calls)
 *   - ./notifications.js   → notification helpers (no real Slack calls)
 *   - ./selfheal.js        → maybeAutoRetry / settleRecovery (no real GitHub calls)
 *   - ./logger.js          → silent logger
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
  listMonitoredRepos: vi.fn(async () => ["fps-api"]),
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
  maybeAutoRetry: vi.fn().mockResolvedValue(false),
  settleRecovery: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks so the mocked versions are used)
// ---------------------------------------------------------------------------

import { pollAll, checkRepo } from "./monitor.js";
import { repoSummary } from "./github.js";
import { notifyRepoRed, notifyRepoRedReminder, notifyAnomaly } from "./notifications.js";
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
 * Arrange the db mock so that loadSnapshot returns `snapshot` (or null).
 * The saveSnapshot call goes through db.insert(...).values(...).onConflictDoUpdate(...)
 * so we mock the full chain.
 */
function mockSnapshot(snapshot: {
  status: string;
  notifiedStatus: string;
  notifiedAnomalySha: string | null;
  lastRedNotifiedAt?: Date | null;
} | null) {
  const row = snapshot
    ? { ...snapshot, lastRedNotifiedAt: snapshot.lastRedNotifiedAt ?? null }
    : null;

  const selectMock = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(row ? [row] : []),
  };
  vi.mocked(db.select).mockReturnValue(selectMock as unknown as ReturnType<typeof db.select>);

  const insertMock = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(db.insert).mockReturnValue(insertMock as unknown as ReturnType<typeof db.insert>);
}

/** Read back the values passed to saveSnapshot via the db.insert mock. */
function getSavedValues(): Record<string, unknown> {
  const insertMock = vi.mocked(db.insert).mock.results[0]?.value as {
    values: ReturnType<typeof vi.fn>;
  };
  return insertMock.values.mock.calls[0]?.[0] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests: status transition detection
// ---------------------------------------------------------------------------

describe("pollAll — status transition detection", () => {
  beforeEach(() => {
    vi.mocked(notifyRepoRed).mockResolvedValue(true);
    vi.mocked(notifyAnomaly).mockResolvedValue(true);
    vi.mocked(notifyRepoRedReminder).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT notify when status is red but was already notified as red (stable red, no reminder due)", async () => {
    // lastRedNotifiedAt = now → reminder not yet due
    mockSnapshot({
      status: "red",
      notifiedStatus: "red",
      notifiedAnomalySha: null,
      lastRedNotifiedAt: new Date(),
    });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red", failReason: "tests falen" }));

    await pollAll();

    expect(notifyRepoRed).not.toHaveBeenCalled();
    expect(notifyRepoRedReminder).not.toHaveBeenCalled();
  });

  it("notifies when status transitions from green to red", async () => {
    mockSnapshot({ status: "green", notifiedStatus: "green", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red", failReason: "tests falen" }));

    await pollAll();

    expect(notifyRepoRed).toHaveBeenCalledOnce();
    expect(notifyRepoRed).toHaveBeenCalledWith(expect.objectContaining({ name: repoName, status: "red" }));
  });

  it("notifies when status transitions from gray to red (no prior snapshot)", async () => {
    // No snapshot → notifiedStatus defaults to "gray"
    mockSnapshot(null);
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red", failReason: "build faalt" }));

    await pollAll();

    expect(notifyRepoRed).toHaveBeenCalledOnce();
  });

  it("does NOT notify on gray status — gray is not a recovery, gray is not red", async () => {
    mockSnapshot({ status: "green", notifiedStatus: "green", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "gray" }));

    await pollAll();

    expect(notifyRepoRed).not.toHaveBeenCalled();
  });

  it("does NOT reset notifiedStatus to green when status transitions to gray (prevents duplicate on next red)", async () => {
    // Repo was red, now gray (workflow in-progress) — notifiedStatus must stay "red"
    mockSnapshot({ status: "red", notifiedStatus: "red", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "gray" }));

    await pollAll();

    expect(notifyRepoRed).not.toHaveBeenCalled();

    const saved = getSavedValues();
    expect(saved["notifiedStatus"]).toBe("red");
  });

  it("resets notifiedStatus when repo recovers from red to green", async () => {
    mockSnapshot({ status: "red", notifiedStatus: "red", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "green" }));

    await pollAll();

    expect(notifyRepoRed).not.toHaveBeenCalled();

    const saved = getSavedValues();
    expect(saved["notifiedStatus"]).toBe("green");
  });

  it("resets lastRedNotifiedAt to null when repo recovers from red to green", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    mockSnapshot({
      status: "red",
      notifiedStatus: "red",
      notifiedAnomalySha: null,
      lastRedNotifiedAt: twoHoursAgo,
    });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "green" }));

    await checkRepo(repoName);

    const saved = getSavedValues();
    expect(saved["lastRedNotifiedAt"]).toBeNull();
  });

  it("does NOT advance notifiedStatus to red when the Slack delivery fails", async () => {
    mockSnapshot({ status: "green", notifiedStatus: "green", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red", failReason: "lint faalt" }));
    vi.mocked(notifyRepoRed).mockResolvedValue(false); // delivery failure

    await pollAll();

    const saved = getSavedValues();
    // notifiedStatus must NOT advance — same as before (green)
    expect(saved["notifiedStatus"]).toBe("green");
  });

  it("persists lastRedNotifiedAt when a new red notification is delivered", async () => {
    mockSnapshot({ status: "green", notifiedStatus: "green", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red", failReason: "build faalt" }));
    vi.mocked(notifyRepoRed).mockResolvedValue(true);

    const before = Date.now();
    await checkRepo(repoName);
    const after = Date.now();

    const saved = getSavedValues();
    const savedTs = saved["lastRedNotifiedAt"] as Date | null;
    expect(savedTs).toBeInstanceOf(Date);
    expect(savedTs!.getTime()).toBeGreaterThanOrEqual(before);
    expect(savedTs!.getTime()).toBeLessThanOrEqual(after);
  });

  it("does NOT set lastRedNotifiedAt when the new-red Slack delivery fails", async () => {
    mockSnapshot({ status: "green", notifiedStatus: "green", notifiedAnomalySha: null });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red", failReason: "lint faalt" }));
    vi.mocked(notifyRepoRed).mockResolvedValue(false);

    await checkRepo(repoName);

    const saved = getSavedValues();
    expect(saved["lastRedNotifiedAt"]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: reminder notifications
// ---------------------------------------------------------------------------

describe("checkRepo — reminder notifications", () => {
  const REMINDER_MS = 60 * 60 * 1000; // 60 minutes (default)

  beforeEach(() => {
    vi.mocked(notifyRepoRed).mockResolvedValue(true);
    vi.mocked(notifyRepoRedReminder).mockResolvedValue(true);
    vi.mocked(notifyAnomaly).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends a reminder when repo is still red and the interval has elapsed", async () => {
    const overOneHourAgo = new Date(Date.now() - REMINDER_MS - 1000);
    mockSnapshot({
      status: "red",
      notifiedStatus: "red",
      notifiedAnomalySha: null,
      lastRedNotifiedAt: overOneHourAgo,
    });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red", failReason: "CI faalt" }));

    await checkRepo(repoName);

    expect(notifyRepoRedReminder).toHaveBeenCalledOnce();
    expect(notifyRepoRed).not.toHaveBeenCalled();
  });

  it("does NOT send a reminder when the interval has not yet elapsed", async () => {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    mockSnapshot({
      status: "red",
      notifiedStatus: "red",
      notifiedAnomalySha: null,
      lastRedNotifiedAt: thirtyMinutesAgo,
    });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red", failReason: "CI faalt" }));

    await checkRepo(repoName);

    expect(notifyRepoRedReminder).not.toHaveBeenCalled();
    expect(notifyRepoRed).not.toHaveBeenCalled();
  });

  it("does NOT send a reminder when lastRedNotifiedAt is null (edge: not yet notified)", async () => {
    // notifiedStatus is somehow red but no timestamp — should not fire reminder
    mockSnapshot({
      status: "red",
      notifiedStatus: "red",
      notifiedAnomalySha: null,
      lastRedNotifiedAt: null,
    });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red", failReason: "CI faalt" }));

    await checkRepo(repoName);

    expect(notifyRepoRedReminder).not.toHaveBeenCalled();
  });

  it("resets the reminder timer (lastRedNotifiedAt) when a reminder is delivered", async () => {
    const overOneHourAgo = new Date(Date.now() - REMINDER_MS - 1000);
    mockSnapshot({
      status: "red",
      notifiedStatus: "red",
      notifiedAnomalySha: null,
      lastRedNotifiedAt: overOneHourAgo,
    });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red", failReason: "CI faalt" }));

    const before = Date.now();
    await checkRepo(repoName);
    const after = Date.now();

    const saved = getSavedValues();
    const savedTs = saved["lastRedNotifiedAt"] as Date | null;
    expect(savedTs).toBeInstanceOf(Date);
    expect(savedTs!.getTime()).toBeGreaterThanOrEqual(before);
    expect(savedTs!.getTime()).toBeLessThanOrEqual(after);
  });

  it("does NOT reset the reminder timer when the reminder delivery fails", async () => {
    const overOneHourAgo = new Date(Date.now() - REMINDER_MS - 1000);
    mockSnapshot({
      status: "red",
      notifiedStatus: "red",
      notifiedAnomalySha: null,
      lastRedNotifiedAt: overOneHourAgo,
    });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red", failReason: "CI faalt" }));
    vi.mocked(notifyRepoRedReminder).mockResolvedValue(false);

    await checkRepo(repoName);

    const saved = getSavedValues();
    const savedTs = saved["lastRedNotifiedAt"] as Date | null;
    // Should still be the old timestamp (unchanged)
    expect(savedTs?.getTime()).toBe(overOneHourAgo.getTime());
  });

  it("notifyRepoRedReminder receives the correct duration (approx)", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * REMINDER_MS);
    mockSnapshot({
      status: "red",
      notifiedStatus: "red",
      notifiedAnomalySha: null,
      lastRedNotifiedAt: twoHoursAgo,
    });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red" }));

    await checkRepo(repoName);

    expect(notifyRepoRedReminder).toHaveBeenCalledOnce();
    const [, durationMs] = vi.mocked(notifyRepoRedReminder).mock.calls[0]!;
    // Duration should be ≈ 2 hours (allow ±5 s for execution time)
    expect(durationMs).toBeGreaterThanOrEqual(2 * REMINDER_MS - 5_000);
    expect(durationMs).toBeLessThanOrEqual(2 * REMINDER_MS + 5_000);
  });
});

// ---------------------------------------------------------------------------
// Tests: anomaly detection
// ---------------------------------------------------------------------------

describe("pollAll — anomaly notification", () => {
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

    const saved = getSavedValues();
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
// Tests: GitHub errors are swallowed gracefully
// ---------------------------------------------------------------------------

describe("pollAll — GitHub error handling", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns without throwing when repoSummary rejects", async () => {
    vi.mocked(repoSummary).mockRejectedValue(new Error("GitHub 503"));

    // Should not throw
    await expect(pollAll()).resolves.toBeUndefined();
    expect(notifyRepoRed).not.toHaveBeenCalled();
  });
});
