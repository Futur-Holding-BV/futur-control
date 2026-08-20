import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("./notifications.js", () => ({
  notifyFinding: vi.fn(),
  notifyDailyFindings: vi.fn(),
}));
vi.mock("./actionlog.js", () => ({
  logAction: vi.fn(async () => 1),
}));
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./expiry.js", () => ({
  listExpiryItems: vi.fn(async () => []),
}));

import {
  checkPublicServices,
  deliverDailyReport,
  deliverImmediateFindings,
  updateFindingLevel,
} from "./findings.js";
import { notifyDailyFindings, notifyFinding } from "./notifications.js";

const finding = {
  id: "service:site",
  kind: "public_service_unavailable",
  subject: "site.example",
  title: "Site onbereikbaar",
  detail: "Drie metingen mislukt",
  level: "NU",
  opened_at: new Date("2026-08-17T12:00:00Z"),
  resolved_at: null,
  auto_resolved: false,
  immediate_sent_at: null,
};

beforeEach(() => {
  query.mockReset();
  clientQuery.mockReset();
  release.mockReset();
  vi.mocked(notifyFinding).mockReset();
  vi.mocked(notifyDailyFindings).mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NU delivery", () => {
  it("sends an open NU finding immediately at 14:00", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ acquired: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [finding] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }], rowCount: 1 });
    vi.mocked(notifyFinding).mockResolvedValue(true);

    await deliverImmediateFindings(new Date("2026-08-17T12:00:00Z"));

    expect(notifyFinding).toHaveBeenCalledWith(
      finding.title,
      finding.detail,
      "NU",
    );
    expect(clientQuery.mock.calls[2]?.[0]).toContain("immediate_sent_at");
  });

  it("holds a 02:00 NU finding and sends it at 07:15 Amsterdam", async () => {
    vi.mocked(notifyFinding).mockResolvedValue(true);

    await deliverImmediateFindings(new Date("2026-08-17T00:00:00Z"));
    expect(notifyFinding).not.toHaveBeenCalled();
    expect(clientQuery).not.toHaveBeenCalled();

    clientQuery
      .mockResolvedValueOnce({ rows: [{ acquired: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [finding] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }], rowCount: 1 });
    await deliverImmediateFindings(new Date("2026-08-17T05:15:00Z"));
    expect(notifyFinding).toHaveBeenCalledOnce();
  });

  it("lets only one instance deliver immediate findings", async () => {
    clientQuery.mockResolvedValueOnce({ rows: [{ acquired: false }], rowCount: 1 });

    await deliverImmediateFindings(new Date("2026-08-17T12:00:00Z"));

    expect(notifyFinding).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("17:00 workday report", () => {
  it("includes a failed build that is still open", async () => {
    const waiting = { ...finding, id: "build:api", kind: "build_failed", level: "KAN_WACHTEN" };
    await deliverDailyReport(new Date("2026-08-17T07:00:00Z"));
    expect(query).not.toHaveBeenCalled();

    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [waiting] })
      .mockResolvedValueOnce({ rows: [{ action: "Controle herhaald", repo: "api", outcome: "geslaagd" }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    vi.mocked(notifyDailyFindings).mockResolvedValue(true);

    await deliverDailyReport(new Date("2026-08-17T15:00:00Z"));

    expect(notifyDailyFindings).toHaveBeenCalledWith(
      [{ title: waiting.title, detail: waiting.detail }],
      [{ action: "Controle herhaald", repo: "api", outcome: "geslaagd" }],
    );
  });

  it("does not send a report on a day without open findings", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await deliverDailyReport(new Date("2026-08-18T15:00:00Z"));

    expect(notifyDailyFindings).not.toHaveBeenCalled();
  });

  it("never sends a report in the weekend", async () => {
    await deliverDailyReport(new Date("2026-08-22T15:00:00Z"));
    expect(query).not.toHaveBeenCalled();
    expect(notifyDailyFindings).not.toHaveBeenCalled();
  });
});

describe("availability debounce and editable levels", () => {
  it("does not create a finding for a service that recovers after three minutes", async () => {
    process.env.EXPIRY_TLS_HOSTS = "site.example";
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await checkPublicServices(new Date("2026-08-17T12:00:00Z"));
    await checkPublicServices(new Date("2026-08-17T12:03:00Z"));

    const sql = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sql).not.toContain("INSERT INTO findings");
  });

  it("updates the database policy and all matching open findings", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ kind: "build_failed", level: "NU" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 });

    await expect(updateFindingLevel("build_failed", "NU")).resolves.toEqual({
      kind: "build_failed",
      level: "NU",
    });
    expect(query.mock.calls[1]?.[0]).toContain("UPDATE findings");
    expect(query.mock.calls[1]?.[1]).toEqual(["build_failed", "NU"]);
  });
});