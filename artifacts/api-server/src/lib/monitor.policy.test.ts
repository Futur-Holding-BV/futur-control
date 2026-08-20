/**
 * Tests for the notification policy in monitor.ts:
 *   • 10-minute debounce — problems shorter than 10 minutes are logged,
 *     never notified.
 *   • Quiet window (Europe/Amsterdam): 22:00–07:15 Mon–Fri, 22:00–09:00
 *     Sat–Sun. Problems that arise during the window and are still open go
 *     out at the first allowed moment; problems that resolved during the
 *     window are logged only.
 *   • Unknown status (gray) counts as a problem.
 *
 * Uses the same mocking approach as monitor.test.ts; the quiet-hours module
 * itself is NOT mocked — real timezone rules with fake system time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const lockClient = {
  query: vi.fn(async (text: string) => {
    if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
    return { rows: [] };
  }),
  release: vi.fn(),
};

vi.mock("@workspace/db", () => ({
  pool: { connect: vi.fn(async () => lockClient) },
  db: { select: vi.fn(), insert: vi.fn() },
  repoStatusSnapshots: {},
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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

import { pollAll } from "./monitor.js";
import { db } from "@workspace/db";
import { listMonitoredRepos, repoSummary } from "./github.js";
import {
  notifyRepoRed,
  notifyMultipleReposRed,
} from "./notifications.js";
import { maybeAutoRetry } from "./selfheal.js";
import { logAction } from "./actionlog.js";
import { openFinding } from "./findings.js";
import type { RepoSummary } from "./github.js";

const repoName = "fps-api";

function makeSummary(overrides: Partial<RepoSummary> = {}): RepoSummary {
  return {
    name: repoName,
    status: "green",
    staleReason: null,
    lastCommitAt: "2026-08-15T08:00:00Z",
    lastPushAt: "2026-08-15T08:00:00Z",
    lastCommitTitle: "fix: something",
    failReason: "Controle faalt",
    htmlUrl: "https://github.com/fps/fps-api",
    anomaly: null,
    recoveredAfterRetry: false,
    ...overrides,
  } as RepoSummary;
}

function mockSnapshot(
  snapshot: {
    status: string;
    notifiedStatus: string;
    notifiedAnomalySha?: string | null;
    lastRedNotifiedAt?: Date | null;
    problemSince?: Date | null;
  } | null,
) {
  const row = snapshot
    ? {
        notifiedAnomalySha: null,
        lastRedNotifiedAt: null,
        problemSince: null,
        ...snapshot,
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

/** Values object passed to db.insert(...).values(...) for the n-th call. */
function savedSnapshot(callIndex = 0): Record<string, unknown> {
  const insertResult = vi.mocked(db.insert).mock.results[callIndex]
    ?.value as { values: ReturnType<typeof vi.fn> };
  return insertResult.values.mock.calls[0]?.[0] as Record<string, unknown>;
}

// Monday 2026-08-17, CEST (UTC+2).
const MONDAY_NOON_UTC = "2026-08-17T10:00:00Z"; // 12:00 Amsterdam (allowed)
const MONDAY_0200_UTC = "2026-08-17T00:00:00Z"; // 02:00 Amsterdam (quiet)
const MONDAY_0230_UTC = "2026-08-17T00:30:00Z"; // 02:30 Amsterdam (quiet)
const MONDAY_0400_UTC = "2026-08-17T02:00:00Z"; // 04:00 Amsterdam (quiet)
const MONDAY_0715_UTC = "2026-08-17T05:15:00Z"; // 07:15 Amsterdam (allowed)

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(listMonitoredRepos).mockResolvedValue([repoName]);
  vi.mocked(maybeAutoRetry).mockResolvedValue({
    holdNotification: false,
    escalationDetail: null,
  });
  vi.mocked(notifyRepoRed).mockResolvedValue(true);
  vi.mocked(notifyMultipleReposRed).mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("debounce — 10 minutes before a notification goes out", () => {
  it("a problem of 3 minutes is logged but never notified", async () => {
    vi.setSystemTime(new Date(MONDAY_NOON_UTC));
    const problemSince = new Date(Date.now() - 3 * 60 * 1000);

    // Poll while red for 3 minutes → too young to notify.
    mockSnapshot({ status: "red", notifiedStatus: "green", problemSince });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red" }));
    await pollAll();
    expect(notifyRepoRed).not.toHaveBeenCalled();
    expect(savedSnapshot(0)["problemSince"]).toEqual(problemSince);

    // Next poll: recovered → suppressed resolution is logged, still no Slack.
    vi.setSystemTime(new Date(Date.now() + 2 * 60 * 1000));
    mockSnapshot({ status: "red", notifiedStatus: "green", problemSince });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "green" }));
    await pollAll();

    expect(notifyRepoRed).not.toHaveBeenCalled();
    expect(logAction).toHaveBeenCalledOnce();
    expect(vi.mocked(logAction).mock.calls[0]![0]).toMatchObject({
      kind: "melding_onderdrukt",
      repo: repoName,
    });
    expect(vi.mocked(logAction).mock.calls[0]![0].reason).toContain(
      "meldingsdrempel",
    );
    // problemSince cleared after recovery (second insert call).
    expect(savedSnapshot(1)["problemSince"]).toBeNull();
  });

  it("a problem of 30 minutes becomes a waiting finding", async () => {
    vi.setSystemTime(new Date(MONDAY_NOON_UTC));
    const problemSince = new Date(Date.now() - 30 * 60 * 1000);

    mockSnapshot({ status: "red", notifiedStatus: "green", problemSince });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red" }));
    await pollAll();

    expect(notifyRepoRed).not.toHaveBeenCalled();
    expect(openFinding).toHaveBeenCalledWith(expect.objectContaining({
      kind: "build_failed",
      subject: repoName,
    }));
    expect(savedSnapshot(0)["notifiedStatus"]).toBe("red");
  });
});

describe("quiet window (Europe/Amsterdam)", () => {
  it("a waiting problem is registered during quiet hours without direct delivery", async () => {
    // 02:30 — problem is 30 minutes old but inside the quiet window.
    vi.setSystemTime(new Date(MONDAY_0230_UTC));
    const problemSince = new Date(MONDAY_0200_UTC);
    mockSnapshot({ status: "red", notifiedStatus: "green", problemSince });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "red" }));
    await pollAll();
    expect(notifyRepoRed).not.toHaveBeenCalled();
    expect(openFinding).toHaveBeenCalledOnce();
    // The problem clock keeps running during the quiet window.
    expect(savedSnapshot(0)["problemSince"]).toEqual(problemSince);

    // 07:15 — first allowed moment: notification goes out.
    vi.setSystemTime(new Date(MONDAY_0715_UTC));
    mockSnapshot({ status: "red", notifiedStatus: "green", problemSince });
    await pollAll();
    expect(notifyRepoRed).not.toHaveBeenCalled();
    expect(openFinding).toHaveBeenCalledTimes(2);
    expect(savedSnapshot(1)["notifiedStatus"]).toBe("red");
  });

  it("two problems still open at 07:15 become two waiting findings", async () => {
    const repos = ["repo-a", "repo-b"];
    vi.mocked(listMonitoredRepos).mockResolvedValue(repos);
    vi.setSystemTime(new Date(MONDAY_0715_UTC));
    mockSnapshot({
      status: "red",
      notifiedStatus: "green",
      problemSince: new Date(MONDAY_0200_UTC),
    });
    vi.mocked(repoSummary).mockImplementation(async (name) =>
      makeSummary({ name, status: "red" }),
    );

    await pollAll();

    expect(notifyRepoRed).not.toHaveBeenCalled();
    expect(notifyMultipleReposRed).not.toHaveBeenCalled();
    expect(openFinding).toHaveBeenCalledTimes(2);
  });

  it("a problem that starts at 02:00 and resolves at 04:00 is logged, never notified", async () => {
    vi.setSystemTime(new Date(MONDAY_0400_UTC));
    mockSnapshot({
      status: "red",
      notifiedStatus: "green",
      problemSince: new Date(MONDAY_0200_UTC),
    });
    vi.mocked(repoSummary).mockResolvedValue(makeSummary({ status: "green" }));

    await pollAll();

    expect(notifyRepoRed).not.toHaveBeenCalled();
    expect(logAction).toHaveBeenCalledOnce();
    expect(vi.mocked(logAction).mock.calls[0]![0].reason).toContain(
      "stiltevenster",
    );
    expect(savedSnapshot(0)["problemSince"]).toBeNull();
  });
});

describe("unknown status counts as a problem", () => {
  it("gray for 30 minutes becomes a codebase-without-check finding", async () => {
    vi.setSystemTime(new Date(MONDAY_NOON_UTC));
    mockSnapshot({
      status: "gray",
      notifiedStatus: "green",
      problemSince: new Date(Date.now() - 30 * 60 * 1000),
    });
    vi.mocked(repoSummary).mockResolvedValue(
      makeSummary({ status: "gray", failReason: null }),
    );

    await pollAll();

    expect(notifyRepoRed).not.toHaveBeenCalled();
    expect(openFinding).toHaveBeenCalledWith(expect.objectContaining({
      kind: "repo_without_check",
      detail: expect.stringContaining("onbekend"),
    }));
    expect(savedSnapshot(0)["notifiedStatus"]).toBe("gray");
    // The helper is consulted because gray can be an in-progress automatic
    // rerun; with no active chain it returns immediately without executing.
    expect(maybeAutoRetry).toHaveBeenCalledWith(
      "fps-api",
      new Date("2026-08-17T10:00:00.000Z"),
    );
  });

  it("gray does not re-notify once the problem was already notified", async () => {
    vi.setSystemTime(new Date(MONDAY_NOON_UTC));
    mockSnapshot({
      status: "gray",
      notifiedStatus: "gray",
      problemSince: new Date(Date.now() - 60 * 60 * 1000),
    });
    vi.mocked(repoSummary).mockResolvedValue(
      makeSummary({ status: "gray", failReason: null }),
    );

    await pollAll();

    expect(notifyRepoRed).not.toHaveBeenCalled();
  });
});
