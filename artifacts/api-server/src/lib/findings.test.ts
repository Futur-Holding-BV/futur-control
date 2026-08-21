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
  markActionsReported: vi.fn(async () => undefined),
}));
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./expiry.js", () => ({
  listExpiryItems: vi.fn(async () => []),
  listTlsExpiryItems: vi.fn(async () => []),
}));
vi.mock("./selfheal.js", () => ({
  restartRepoForHost: vi.fn(() => null),
  maybeAutoRestartService: vi.fn(async () => ({
    holdNotification: false,
    escalationDetail: null,
  })),
  settleServiceRecovery: vi.fn(async () => false),
}));

import {
  checkPublicServices,
  deliverDailyReport,
  deliverImmediateFindings,
  millisecondsUntilNextDailyReportCheck,
  updateFindingLevel,
} from "./findings.js";
import { notifyDailyFindings, notifyFinding } from "./notifications.js";
import { markActionsReported } from "./actionlog.js";

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
  delete process.env.CONNECT_STATUS_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NU delivery", () => {
  it("sends an open NU finding immediately at 14:00", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ acquired: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [finding] })
      .mockResolvedValueOnce({ rows: [{ id: finding.id }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }], rowCount: 1 });
    vi.mocked(notifyFinding).mockResolvedValue(true);

    await deliverImmediateFindings(new Date("2026-08-17T12:00:00Z"));

    expect(notifyFinding).toHaveBeenCalledWith(
      finding.title,
      finding.detail,
      "NU",
    );
    expect(clientQuery.mock.calls[2]?.[0]).toContain("immediate_claim_token");
    expect(clientQuery.mock.calls[3]?.[0]).toContain("immediate_sent_at = now()");
  });

  it("holds a 02:00 NU finding and sends it at 07:15 Amsterdam", async () => {
    vi.mocked(notifyFinding).mockResolvedValue(true);

    await deliverImmediateFindings(new Date("2026-08-17T00:00:00Z"));
    expect(notifyFinding).not.toHaveBeenCalled();
    expect(clientQuery).not.toHaveBeenCalled();

    clientQuery
      .mockResolvedValueOnce({ rows: [{ acquired: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [finding] })
      .mockResolvedValueOnce({ rows: [{ id: finding.id }], rowCount: 1 })
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

  it("claims a finding before sending so a second process cannot duplicate it", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ acquired: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [finding] })
      .mockResolvedValueOnce({ rows: [{ id: finding.id }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }], rowCount: 1 });
    vi.mocked(notifyFinding).mockResolvedValue(true);

    await deliverImmediateFindings(new Date("2026-08-17T12:00:00Z"));

    expect(String(clientQuery.mock.calls[2]?.[0])).toContain(
      "immediate_claim_token = $2",
    );
    expect(String(clientQuery.mock.calls[3]?.[0])).toContain(
      "immediate_sent_at = now()",
    );
    expect(clientQuery.mock.calls[2]?.[1]?.[1]).toBe(
      clientQuery.mock.calls[3]?.[1]?.[1],
    );
    expect(notifyFinding).toHaveBeenCalledOnce();
  });

  it("releases its claim when no channel handled the finding", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ acquired: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [finding] })
      .mockResolvedValueOnce({ rows: [{ id: finding.id }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }], rowCount: 1 });
    vi.mocked(notifyFinding).mockResolvedValue(false);

    await deliverImmediateFindings(new Date("2026-08-17T12:00:00Z"));

    expect(String(clientQuery.mock.calls[3]?.[0])).toContain(
      "immediate_claim_token = NULL",
    );
    expect(clientQuery.mock.calls[3]?.[1]?.[0]).toBe(finding.id);
    expect(clientQuery.mock.calls[3]?.[1]?.[1]).toBe(
      clientQuery.mock.calls[2]?.[1]?.[1],
    );
  });
});

describe("17:00 workday report", () => {
  it("includes a failed build that is still open", async () => {
    const waiting = { ...finding, id: "build:api", kind: "build_failed", level: "KAN_WACHTEN" };
    await deliverDailyReport(new Date("2026-08-17T07:00:00Z"));
    expect(query).not.toHaveBeenCalled();

    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ value: "2026-08-17" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [waiting] })
      .mockResolvedValueOnce({ rows: [{ id: 7, action: "Controle herhaald", repo: "api", outcome: "geslaagd" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    vi.mocked(notifyDailyFindings).mockResolvedValue({ handled: true, confirmed: true });

    await deliverDailyReport(new Date("2026-08-17T15:00:00Z"));

    expect(notifyDailyFindings).toHaveBeenCalledWith(
      [{ title: waiting.title, detail: waiting.detail, kind: waiting.kind }],
      [{ action: "Controle herhaald", repo: "api", outcome: "geslaagd" }],
      "2026-08-17",
      expect.arrayContaining([
        expect.objectContaining({ id: "connect:production", status: "unknown" }),
      ]),
    );
    expect(markActionsReported).toHaveBeenCalledWith([7]);
  });

  it("sends a proof-of-monitoring report on a clean workday", async () => {
    query.mockImplementation(async (sql: string) => ({
      rows: String(sql).includes("RETURNING value")
        ? [{ value: "2026-08-18" }]
        : [],
      rowCount: 1,
    }));
    vi.mocked(notifyDailyFindings).mockResolvedValue({ handled: true, confirmed: true });

    await deliverDailyReport(new Date("2026-08-18T15:00:00Z"));

    expect(notifyDailyFindings).toHaveBeenCalledWith(
      [],
      [],
      "2026-08-18",
      expect.any(Array),
    );
    expect(query.mock.calls.map((call) => String(call[0])).join("\n"))
      .toContain("daily-report-first-due");
  });

  it("sends a successful automatic action even when there are no open findings", async () => {
    const action = {
      id: 8,
      action: "Dienst opnieuw gestart",
      repo: "api",
      outcome: "geslaagd — dienst is weer bereikbaar",
    };
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ value: "2026-08-18" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [action] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    vi.mocked(notifyDailyFindings).mockResolvedValue({ handled: true, confirmed: true });

    await deliverDailyReport(new Date("2026-08-18T15:00:00Z"));

    expect(notifyDailyFindings).toHaveBeenCalledWith(
      [],
      [{ action: action.action, repo: action.repo, outcome: action.outcome }],
      "2026-08-18",
      expect.any(Array),
    );
    expect(markActionsReported).toHaveBeenCalledWith([8]);
  });

  it("does not treat a mail that is only queued as confirmed delivery", async () => {
    query.mockImplementation(async (sql: string) => ({
      rows: String(sql).includes("RETURNING value")
        ? [{ value: "2026-08-18" }]
        : [],
      rowCount: 1,
    }));
    vi.mocked(notifyDailyFindings).mockResolvedValue({ handled: true, confirmed: false });

    await deliverDailyReport(new Date("2026-08-18T15:00:00Z"));

    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((statement) => statement.includes("VALUES ('daily-report-pending'"))).toBe(true);
    expect(sql.some((statement) => statement.includes("VALUES ('daily-report',"))).toBe(false);
  });

  it("never sends a report in the weekend", async () => {
    await deliverDailyReport(new Date("2026-08-22T15:00:00Z"));
    expect(query).not.toHaveBeenCalled();
    expect(notifyDailyFindings).not.toHaveBeenCalled();
  });

  it("uses 17:00 Amsterdam during winter time too", async () => {
    query.mockImplementation(async (sql: string) => ({
      rows: String(sql).includes("RETURNING value")
        ? [{ value: "2026-01-19" }]
        : [],
      rowCount: 1,
    }));
    vi.mocked(notifyDailyFindings).mockResolvedValue({ handled: true, confirmed: true });

    // 17:00 CET on a Monday; the same instant is only 16:00 UTC.
    await deliverDailyReport(new Date("2026-01-19T16:00:00Z"));

    expect(notifyDailyFindings).toHaveBeenCalledWith(
      [],
      [],
      "2026-01-19",
      expect.any(Array),
    );
  });

  it("lets only one concurrent process claim a day's report", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await deliverDailyReport(new Date("2026-08-18T15:00:00Z"));

    expect(notifyDailyFindings).not.toHaveBeenCalled();
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("daily-report-claim"),
      ),
    ).toBe(true);
  });

  it("aligns the independent scheduler to a 30-second wall-clock boundary", () => {
    expect(millisecondsUntilNextDailyReportCheck(30_000)).toBe(30_000);
    expect(millisecondsUntilNextDailyReportCheck(30_001)).toBe(29_999);
    expect(millisecondsUntilNextDailyReportCheck(59_999)).toBe(1);
  });
});

describe("availability debounce and editable levels", () => {
  it("neemt de Connect-productiehost automatisch mee in de dienstbewaking", async () => {
    process.env.EXPIRY_TLS_HOSTS = "";
    process.env.CONNECT_STATUS_URL =
      "https://connect.example/api/beheerstatus";
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 200 }));
    query.mockResolvedValue({ rows: [], rowCount: 1 });

    await checkPublicServices(new Date("2026-08-20T08:00:00Z"));

    expect(fetch).toHaveBeenCalledWith(
      "https://connect.example",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

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

  it("opens one precise certificate finding and suppresses the generic outage", async () => {
    process.env.EXPIRY_TLS_HOSTS = "sparki-insight.nl";
    const certificateError = Object.assign(new Error("fetch failed"), {
      cause: Object.assign(
        new Error(
          "Host: sparki-insight.nl is not in the cert's altnames: DNS:*.vdx.nl",
        ),
        { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
      ),
    });
    vi.mocked(fetch).mockRejectedValue(certificateError);
    query.mockResolvedValue({ rows: [], rowCount: 1 });

    await checkPublicServices(new Date("2026-08-20T08:09:00Z"));

    const allSql = query.mock.calls.map(([sql]) => String(sql)).join("\n");
    expect(allSql).toContain("VALUES ($1, '0', now())");
    const inserts = query.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO findings"),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.[1]?.[0]).toBe("expiry:tls:sparki-insight.nl");
    expect(inserts[0]?.[1]?.[2]).toBe("tls:sparki-insight.nl");
    expect(inserts[0]?.[1]?.[4]).toContain(
      "DNS:*.vdx.nl",
    );
    expect(inserts[0]?.[1]?.[5]).toBe("NU");
  });

  it("opens a direct service finding with the measured outage cause", async () => {
    process.env.EXPIRY_TLS_HOSTS = "offline.example";
    const refused = Object.assign(new Error("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    });
    vi.mocked(fetch).mockRejectedValue(refused);
    query
      .mockResolvedValueOnce({
        rows: [
          {
            value: JSON.stringify({
              count: 2,
              firstAt: new Date("2026-08-20T08:00:00Z").getTime(),
            }),
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ level: "NU" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await checkPublicServices(new Date("2026-08-20T08:10:00Z"));

    const findingInsert = query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO findings"),
    );
    expect(findingInsert?.[1]?.[4]).toContain(
      "De dienst draait niet of poort 443 luistert niet",
    );
    expect(findingInsert?.[1]?.[5]).toBe("NU");
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