import { describe, it, expect } from "vitest";
import { applyStaleness, DEFAULT_YELLOW_DAYS, DEFAULT_RED_DAYS } from "./staleness";

const thresholds = { staleYellowDays: DEFAULT_YELLOW_DAYS, staleRedDays: DEFAULT_RED_DAYS };
const now = new Date("2026-08-17T12:00:00Z");

function daysAgo(days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

describe("applyStaleness", () => {
  it("no commit information: status becomes unknown (gray), never green", () => {
    const result = applyStaleness("green", null, thresholds, now);
    expect(result.status).toBe("gray");
    expect(result.status).not.toBe("green");
    expect(result.staleReason).toContain("geen commit-informatie");
  });

  it("gray checkStatus + null lastCommitAt: staleReason explains both absences", () => {
    // Repo that has never run checks AND has no commit information.
    // The dashboard must show a reason rather than a bare gray dot.
    const result = applyStaleness("gray", null, thresholds, now);
    expect(result.status).toBe("gray");
    expect(result.staleReason).not.toBeNull();
    expect(result.staleReason).toMatch(/checks/i);
    expect(result.staleReason).toMatch(/commit/i);
  });

  it("no commit information: an existing red stays red", () => {
    const result = applyStaleness("red", null, thresholds, now);
    expect(result.status).toBe("red");
    expect(result.staleReason).toBeNull();
  });

  it("no commit information: an invalid date is treated as unknown", () => {
    const result = applyStaleness("green", new Date("nonsense"), thresholds, now);
    expect(result.status).toBe("gray");
  });

  it("commit from today: status stays green without stale reason", () => {
    const result = applyStaleness("green", daysAgo(0), thresholds, now);
    expect(result.status).toBe("green");
    expect(result.staleReason).toBeNull();
  });

  it("commit 8 days old: status becomes yellow", () => {
    const result = applyStaleness("green", daysAgo(8), thresholds, now);
    expect(result.status).toBe("yellow");
    expect(result.staleReason).toContain("8 dagen oud");
  });

  it("commit 8 days old but check already red: red wins over yellow", () => {
    const result = applyStaleness("red", daysAgo(8), thresholds, now);
    expect(result.status).toBe("red");
    expect(result.staleReason).toBeNull();
  });

  it("commit 20 days old but check already red: keeps the failure reason (no stale reason)", () => {
    const result = applyStaleness("red", daysAgo(20), thresholds, now);
    expect(result.status).toBe("red");
    expect(result.staleReason).toBeNull();
  });

  it("commit 20 days old: status becomes red with stale reason", () => {
    const result = applyStaleness("green", daysAgo(20), thresholds, now);
    expect(result.status).toBe("red");
    expect(result.staleReason).toContain("20 dagen oud");
    expect(result.staleReason).toContain("14 dagen");
  });

  it("custom thresholds: a deliberately paused project stays green", () => {
    const result = applyStaleness(
      "green",
      daysAgo(20),
      { staleYellowDays: 60, staleRedDays: 90 },
      now,
    );
    expect(result.status).toBe("green");
    expect(result.staleReason).toBeNull();
  });
});
