import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, clientQuery, release } = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
}));
vi.mock("@workspace/db", () => ({
  pool: {
    query,
    connect: vi.fn(async () => ({ query: clientQuery, release })),
  },
}));
vi.mock("./findings.js", () => ({
  openFinding: vi.fn(async () => undefined),
  resolveFinding: vi.fn(async () => undefined),
  deliverImmediateFindings: vi.fn(async () => undefined),
}));
vi.mock("./mail.js", () => ({
  sendMailDirect: vi.fn(async () => undefined),
}));
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runWatchdog } from "./watchdog.js";
import {
  deliverImmediateFindings,
  openFinding,
} from "./findings.js";
import { sendMailDirect } from "./mail.js";

beforeEach(() => {
  vi.clearAllMocks();
  clientQuery.mockImplementation(async (text: string) => {
    if (text.includes("pg_try_advisory_lock")) {
      return { rows: [{ acquired: true }], rowCount: 1 };
    }
    return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
  });
});

describe("monitor heartbeat watchdog", () => {
  it("opens and independently delivers a NU finding after two hours", async () => {
    query.mockResolvedValue({
      rows: [{ value: "2026-08-17T09:00:00.000Z" }],
      rowCount: 1,
    });
    const now = new Date("2026-08-17T12:00:00.000Z");

    await runWatchdog(now);

    expect(openFinding).toHaveBeenCalledWith(expect.objectContaining({
      id: "self:heartbeat",
      kind: "monitor_unhealthy",
    }));
    expect(deliverImmediateFindings).toHaveBeenCalledWith(now);
  });

  it("keeps a stale heartbeat queued during the quiet window", async () => {
    query.mockResolvedValue({
      rows: [{ value: "2026-08-16T20:00:00.000Z" }],
      rowCount: 1,
    });

    await runWatchdog(new Date("2026-08-17T00:00:00.000Z"));

    expect(openFinding).toHaveBeenCalledOnce();
    // The common delivery helper applies the quiet-window policy itself.
    expect(deliverImmediateFindings).toHaveBeenCalledOnce();
  });

  it("alerts through the database-independent mail path when PostgreSQL is down", async () => {
    query.mockRejectedValue(new Error("database unavailable"));

    await runWatchdog(new Date("2026-08-17T12:00:00.000Z"));

    expect(sendMailDirect).toHaveBeenCalledOnce();
    expect(openFinding).not.toHaveBeenCalled();
  });

  it("opens an actionable finding after two missed Amsterdam workday reports", async () => {
    const now = new Date("2026-08-18T15:15:00.000Z"); // Tuesday 17:15 CEST
    query
      .mockResolvedValueOnce({
        rows: [{ value: "2026-08-18T14:55:00.000Z" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          { key: "daily-report", value: "2026-08-14" }, // Friday
          { key: "daily-report-first-due", value: "2026-08-14" },
        ],
        rowCount: 2,
      });

    await runWatchdog(now);

    expect(openFinding).toHaveBeenCalledWith(expect.objectContaining({
      id: "self:daily-report",
      kind: "monitor_unhealthy",
      title: expect.stringContaining("Twee werkdagberichten"),
      detail: expect.stringContaining("mailaflevering"),
    }));
    expect(deliverImmediateFindings).toHaveBeenCalledWith(now);
  });

  it("detects the second missed report even before any report has succeeded", async () => {
    const now = new Date("2026-08-18T15:15:00.000Z"); // Tuesday 17:15 CEST
    query
      .mockResolvedValueOnce({
        rows: [{ value: "2026-08-18T14:55:00.000Z" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ key: "daily-report-first-due", value: "2026-08-17" }],
        rowCount: 1,
      });

    await runWatchdog(now);

    expect(openFinding).toHaveBeenCalledWith(expect.objectContaining({
      id: "self:daily-report",
    }));
  });

  it("does not race the in-flight daily report at exactly 17:00 Amsterdam", async () => {
    const now = new Date("2026-08-18T15:00:00.000Z"); // Tuesday 17:00 CEST
    query
      .mockResolvedValueOnce({
        rows: [{ value: "2026-08-18T14:55:00.000Z" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          { key: "daily-report", value: "2026-08-14" },
          { key: "daily-report-first-due", value: "2026-08-14" },
        ],
        rowCount: 2,
      });

    await runWatchdog(now);

    expect(openFinding).not.toHaveBeenCalledWith(expect.objectContaining({
      id: "self:daily-report",
    }));
  });

  it("waits for an active 17:00 monitor round even after the grace period", async () => {
    const now = new Date("2026-08-18T15:20:00.000Z"); // Tuesday 17:20 CEST
    query
      .mockResolvedValueOnce({
        rows: [{ value: "2026-08-18T14:55:00.000Z" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          { key: "daily-report", value: "2026-08-14" },
          { key: "daily-report-first-due", value: "2026-08-14" },
        ],
        rowCount: 2,
      });
    clientQuery.mockResolvedValueOnce({
      rows: [{ acquired: false }],
      rowCount: 1,
    });

    await runWatchdog(now);

    expect(openFinding).not.toHaveBeenCalledWith(expect.objectContaining({
      id: "self:daily-report",
    }));
    expect(deliverImmediateFindings).not.toHaveBeenCalled();
  });

  it("does not let a stale persisted round marker hide missed reports after a crash", async () => {
    const now = new Date("2026-08-18T15:20:00.000Z"); // Tuesday 17:20 CEST
    query
      .mockResolvedValueOnce({
        rows: [{ value: "2026-08-18T14:55:00.000Z" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          { key: "daily-report", value: "2026-08-14" },
          { key: "daily-report-first-due", value: "2026-08-14" },
          { key: "monitor-round-started-at", value: "2026-08-18T15:00:00.000Z" },
        ],
        rowCount: 3,
      });

    await runWatchdog(now);

    expect(openFinding).toHaveBeenCalledWith(expect.objectContaining({
      id: "self:daily-report",
    }));
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("pg_try_advisory_lock"),
      expect.any(Array),
    );
  });

  it("does not count a weekend or the time before 17:00 as another missed report", async () => {
    const now = new Date("2026-08-17T14:59:00.000Z"); // Monday 16:59 CEST
    query
      .mockResolvedValueOnce({
        rows: [{ value: "2026-08-17T14:55:00.000Z" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          { key: "daily-report", value: "2026-08-14" }, // Friday
          { key: "daily-report-first-due", value: "2026-08-14" },
        ],
        rowCount: 2,
      });

    await runWatchdog(now);

    expect(openFinding).not.toHaveBeenCalledWith(expect.objectContaining({
      id: "self:daily-report",
    }));
  });
});