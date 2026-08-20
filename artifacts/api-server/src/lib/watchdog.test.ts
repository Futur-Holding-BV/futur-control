import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@workspace/db", () => ({ pool: { query } }));
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
});