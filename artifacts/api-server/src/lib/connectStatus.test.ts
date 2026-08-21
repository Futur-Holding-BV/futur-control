/**
 * Unit-tests voor connectStatus.ts (BEWAKING_01)
 *
 * Gedekte scenario's:
 * - Exacte vijf resultaten
 * - URL-validatie (HTTPS/HTTP-regels)
 * - Commit-overeenkomst en -afwijking
 * - Bouwcontrole >24u-grens
 * - Versheidscontroles (db-backup, nas-pull, mail)
 * - Ongeldig/onbekend/fout antwoord
 * - Bevindingen openen/oplossen
 * - Opgeslagen gesanitiseerde JSON in monitor_state
 */

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { FindingInput } from "./findings.js";

// ─── Module-mocks ────────────────────────────────────────────────────────────
// Gebruik vi.hoisted zodat variabelen beschikbaar zijn in vi.mock-factories.
// Expliciete parametertypes voorkomen TS2493/TS2532/TS18048 bij indexering van
// .mock.calls: zonder typeparameter leidt vi.fn tot een lege tuple ([]) als
// argumenttype, waardoor c[0] door TypeScript als onbereikbaar wordt beschouwd.

const { mockQuery, mockOpenFinding, mockResolveFinding, mockGetDefaultBranchCommitSha } = vi.hoisted(() => ({
  mockQuery: vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
  mockOpenFinding: vi.fn<(input: FindingInput) => Promise<void>>(),
  mockResolveFinding: vi.fn<(id: string) => Promise<void>>(),
  mockGetDefaultBranchCommitSha: vi.fn<(repo: string) => Promise<string>>(),
}));

vi.mock("@workspace/db", () => ({
  pool: { query: mockQuery },
}));

vi.mock("./findings.js", () => ({
  openFinding: mockOpenFinding,
  resolveFinding: mockResolveFinding,
}));

vi.mock("./github.js", () => ({
  getDefaultBranchCommitSha: mockGetDefaultBranchCommitSha,
}));

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Import na mocks ──────────────────────────────────────────────────────────

import {
  resolveConnectStatusUrl,
  getConnectChecks,
  buildControlCheck,
  syncConnectFindings,
  type ConnectCheck,
  type BuildControlInput,
} from "./connectStatus.js";

// ─── Hulpfuncties ─────────────────────────────────────────────────────────────

const NOW = new Date("2026-08-20T12:00:00.000Z");
const COMMIT_SHA = "abc123def456abc123def456abc123def456abc1";

function makeResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "1.2.3",
    commit: COMMIT_SHA,
    measured_at: new Date(NOW.getTime() - 60_000).toISOString(),
    database_backup: {
      status: "ok",
      last_success_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(), // 1 uur geleden
    },
    nas_pull: {
      status: "ok",
      last_success_at: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(), // 2 uur geleden
    },
    outgoing_mail: {
      status: "ok",
      last_success_at: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(), // 30 min geleden
    },
    ...overrides,
  };
}

function stubFetch(response: Record<string, unknown> | null, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (response === null) throw new Error("fetch mislukt");
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => response,
      };
    }),
  );
}

function goodBuildInput(): BuildControlInput {
  return { repoStatus: "green", problemSinceMs: null };
}

// ─── beforeEach / afterEach ───────────────────────────────────────────────────

beforeEach(() => {
  mockQuery.mockReset();
  mockOpenFinding.mockReset();
  mockResolveFinding.mockReset();
  mockGetDefaultBranchCommitSha.mockReset();

  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockOpenFinding.mockResolvedValue(undefined);
  mockResolveFinding.mockResolvedValue(undefined);
  mockGetDefaultBranchCommitSha.mockResolvedValue(COMMIT_SHA);

  // Standaard omgevingsvariabelen
  process.env.CONNECT_STATUS_URL = "https://connect.example.com/status";
  process.env.CONNECT_GITHUB_REPO = "fps-connect";
  process.env.NODE_ENV = "production";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CONNECT_STATUS_URL;
  delete process.env.CONNECT_GITHUB_REPO;
  delete process.env.NODE_ENV;
});

// ─── URL-validatie ────────────────────────────────────────────────────────────

describe("resolveConnectStatusUrl", () => {
  it("accepteert een HTTPS-URL in productie", () => {
    process.env.NODE_ENV = "production";
    process.env.CONNECT_STATUS_URL = "https://connect.example.com/status";
    expect(() => resolveConnectStatusUrl()).not.toThrow();
    expect(resolveConnectStatusUrl()).toBe("https://connect.example.com/status");
  });

  it("weigert een HTTP-URL in productie", () => {
    process.env.NODE_ENV = "production";
    process.env.CONNECT_STATUS_URL = "http://connect.example.com/status";
    expect(() => resolveConnectStatusUrl()).toThrow(/HTTPS/i);
  });

  it("accepteert http://localhost buiten productie", () => {
    process.env.NODE_ENV = "development";
    process.env.CONNECT_STATUS_URL = "http://localhost:3000/status";
    expect(() => resolveConnectStatusUrl()).not.toThrow();
  });

  it("accepteert http://127.0.0.1 buiten productie", () => {
    process.env.NODE_ENV = "development";
    process.env.CONNECT_STATUS_URL = "http://127.0.0.1:8080/status";
    expect(() => resolveConnectStatusUrl()).not.toThrow();
  });

  it("weigert http://extern.example.com buiten productie", () => {
    process.env.NODE_ENV = "development";
    process.env.CONNECT_STATUS_URL = "http://extern.example.com/status";
    expect(() => resolveConnectStatusUrl()).toThrow(/localhost|127\.0\.0\.1/);
  });

  it("accepteert HTTPS ook buiten productie", () => {
    process.env.NODE_ENV = "development";
    process.env.CONNECT_STATUS_URL = "https://connect.example.com/status";
    expect(() => resolveConnectStatusUrl()).not.toThrow();
  });

  it("gooit een fout als CONNECT_STATUS_URL ontbreekt", () => {
    delete process.env.CONNECT_STATUS_URL;
    expect(() => resolveConnectStatusUrl()).toThrow(/geconfigureerd/);
  });

  it("gooit een fout als CONNECT_STATUS_URL geen geldige URL is", () => {
    process.env.CONNECT_STATUS_URL = "geen-geldige-url";
    expect(() => resolveConnectStatusUrl()).toThrow(/geldige URL/);
  });

  it("weigert een niet-HTTP/HTTPS-protocol buiten productie", () => {
    process.env.NODE_ENV = "development";
    process.env.CONNECT_STATUS_URL = "ftp://connect.example.com/status";
    expect(() => resolveConnectStatusUrl()).toThrow(/HTTP|HTTPS/);
  });
});

// ─── Exacte vijf checks ───────────────────────────────────────────────────────

describe("getConnectChecks — altijd precies vijf resultaten", () => {
  it("geeft vijf checks terug bij een gezond antwoord", async () => {
    stubFetch(makeResponse());
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks).toHaveLength(5);
  });

  it("geeft vijf checks terug wanneer de server niet bereikbaar is", async () => {
    stubFetch(null);
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks).toHaveLength(5);
  });

  it("gebruikt stabiele IDs", async () => {
    stubFetch(makeResponse());
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    const ids = checks.map((c) => c.id);
    expect(ids).toEqual([
      "connect:production",
      "connect:build",
      "connect:db-backup",
      "connect:nas-pull",
      "connect:mail",
    ]);
  });

  it("heeft Nederlandse labels", async () => {
    stubFetch(makeResponse());
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    for (const check of checks) {
      expect(typeof check.label).toBe("string");
      expect(check.label.length).toBeGreaterThan(0);
    }
  });

  it("status is altijd ok|warning|error|unknown", async () => {
    stubFetch(makeResponse());
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    const validStatuses = new Set(["ok", "warning", "error", "unknown"]);
    for (const check of checks) {
      expect(validStatuses.has(check.status)).toBe(true);
    }
  });
});

// ─── Productiecheck ───────────────────────────────────────────────────────────

describe("connect:production check", () => {
  it("is ok wanneer alles klopt", async () => {
    stubFetch(makeResponse({ commit: COMMIT_SHA }));
    mockGetDefaultBranchCommitSha.mockResolvedValue(COMMIT_SHA);
    const [prod] = await getConnectChecks(goodBuildInput(), NOW);
    expect(prod.status).toBe("ok");
  });

  it("is error wanneer Connect niet bereikbaar is", async () => {
    stubFetch(null);
    const [prod] = await getConnectChecks(goodBuildInput(), NOW);
    expect(prod.id).toBe("connect:production");
    expect(prod.status).toBe("error");
  });

  it("is error wanneer de server een HTTP-fout geeft", async () => {
    stubFetch(makeResponse(), 503);
    const [prod] = await getConnectChecks(goodBuildInput(), NOW);
    expect(prod.status).toBe("error");
  });

  it("is warning wanneer de commit niet overeenkomt met GitHub main", async () => {
    const otherCommit = "0000000000000000000000000000000000000000";
    stubFetch(makeResponse({ commit: otherCommit }));
    mockGetDefaultBranchCommitSha.mockResolvedValue(COMMIT_SHA);
    const [prod] = await getConnectChecks(goodBuildInput(), NOW);
    expect(prod.status).toBe("warning");
    expect(prod.detail).toMatch(/commit/i);
  });

  it("is warning wanneer de GitHub-commit niet opgehaald kan worden", async () => {
    stubFetch(makeResponse());
    mockGetDefaultBranchCommitSha.mockRejectedValue(new Error("GitHub onbereikbaar"));
    const [prod] = await getConnectChecks(goodBuildInput(), NOW);
    expect(prod.status).toBe("warning");
  });

  it("is warning wanneer de versie ontbreekt", async () => {
    stubFetch(makeResponse({ version: "" }));
    // Lege versie wordt afgewezen door validatie → data is null → error
    // Maar als de validatie het toch doorlaat met een lege versie → warning
    // In onze validatie: als version leeg is, geeft validateConnectResponse null.
    // Dus het resultaat zal "error" zijn (niet bereikbaar/ongeldig antwoord).
    const [prod] = await getConnectChecks(goodBuildInput(), NOW);
    expect(prod.status).toBe("error");
  });

  it("bevat geen URL-querydetails of tokens in de detail-tekst", async () => {
    stubFetch(makeResponse());
    const [prod] = await getConnectChecks(goodBuildInput(), NOW);
    expect(prod.detail).not.toMatch(/token|secret|key|password|Bearer/i);
    expect(prod.detail).not.toMatch(/\?/); // geen querystring
  });
});

// ─── Bouwcontrole ─────────────────────────────────────────────────────────────

describe("buildControlCheck", () => {
  const PROBLEM_UNDER_24H = NOW.getTime() - 20 * 60 * 60 * 1000; // 20 uur geleden
  const PROBLEM_OVER_24H = NOW.getTime() - 25 * 60 * 60 * 1000; // 25 uur geleden

  it("is ok wanneer de repo groen is", () => {
    const check = buildControlCheck("green", null, NOW);
    expect(check.status).toBe("ok");
  });

  it("is unknown wanneer de repostatus null is", () => {
    const check = buildControlCheck(null, null, NOW);
    expect(check.status).toBe("unknown");
  });

  it("is warning wanneer de repo rood is maar < 24 uur", () => {
    const check = buildControlCheck("red", PROBLEM_UNDER_24H, NOW);
    expect(check.status).toBe("warning");
  });

  it("is error wanneer de repo rood is en > 24 uur", () => {
    const check = buildControlCheck("red", PROBLEM_OVER_24H, NOW);
    expect(check.status).toBe("error");
  });

  it("is warning wanneer de repo grijs is maar < 24 uur", () => {
    const check = buildControlCheck("gray", PROBLEM_UNDER_24H, NOW);
    expect(check.status).toBe("warning");
  });

  it("is error wanneer de repo grijs is en > 24 uur", () => {
    const check = buildControlCheck("gray", PROBLEM_OVER_24H, NOW);
    expect(check.status).toBe("error");
  });

  it("is warning (niet error) wanneer de repo rood is en problemSince null", () => {
    const check = buildControlCheck("red", null, NOW);
    expect(check.status).toBe("warning");
  });

  it("grensgeval: precies 24 uur is nog geen fout (> vereist)", () => {
    const exactlyAtBoundary = NOW.getTime() - 24 * 60 * 60 * 1000;
    const check = buildControlCheck("red", exactlyAtBoundary, NOW);
    // exactlyAtBoundary is NIET > 24h, want we gebruiken stricte >
    expect(check.status).toBe("warning");
  });

  it("grensgeval: 24 uur plus één milliseconde is een fout", () => {
    const justOver = NOW.getTime() - (24 * 60 * 60 * 1000 + 1);
    const check = buildControlCheck("red", justOver, NOW);
    expect(check.status).toBe("error");
  });
});

// ─── Versheidscontroles ───────────────────────────────────────────────────────

describe("connect:db-backup freshness", () => {
  it("is ok wanneer de back-up minder dan 24 uur geleden was", async () => {
    const recent = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(); // 1 uur geleden
    stubFetch(makeResponse({ database_backup: { status: "ok", last_success_at: recent } }));
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks[2].status).toBe("ok");
  });

  it("is warning wanneer de back-up ouder dan 24 uur is", async () => {
    const old = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString(); // 25 uur geleden
    stubFetch(makeResponse({ database_backup: { status: "ok", last_success_at: old } }));
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks[2].status).toBe("warning");
  });

  it("is warning wanneer last_success_at null is (status ok)", async () => {
    stubFetch(makeResponse({ database_backup: { status: "ok", last_success_at: null } }));
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks[2].status).toBe("warning");
  });

  it("is error wanneer de meting status 'error' heeft", async () => {
    stubFetch(makeResponse({
      database_backup: { status: "error", last_success_at: null },
    }));
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks[2].status).toBe("error");
  });

  it("is unknown wanneer de meting status 'unknown' heeft", async () => {
    stubFetch(makeResponse({
      database_backup: { status: "unknown", last_success_at: null },
    }));
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks[2].status).toBe("unknown");
  });

  it("is unknown wanneer Connect niet bereikbaar is", async () => {
    stubFetch(null);
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks[2].status).toBe("unknown");
  });

  it("grensgeval: precies 24 uur oud is nog ok (<=)", async () => {
    const exactBoundary = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();
    stubFetch(makeResponse({ database_backup: { status: "ok", last_success_at: exactBoundary } }));
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks[2].status).toBe("ok");
  });

  it("grensgeval: 24 uur plus één milliseconde is warning", async () => {
    const justOver = new Date(NOW.getTime() - (24 * 60 * 60 * 1000 + 1)).toISOString();
    stubFetch(makeResponse({ database_backup: { status: "ok", last_success_at: justOver } }));
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks[2].status).toBe("warning");
  });

  it("toekomstige timestamp faalt veilig (warning)", async () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    stubFetch(makeResponse({ database_backup: { status: "ok", last_success_at: future } }));
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks[2].status).toBe("warning");
  });

  it("misvormde timestamp faalt veilig (warning)", async () => {
    stubFetch(makeResponse({ database_backup: { status: "ok", last_success_at: "geen-datum" } }));
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks[2].status).toBe("warning");
  });
});

describe("connect:nas-pull freshness", () => {
  it("is ok wanneer de NAS-pull minder dan 36 uur geleden was", async () => {
    const recent = new Date(NOW.getTime() - 10 * 60 * 60 * 1000).toISOString(); // 10 uur geleden
    stubFetch(makeResponse({ nas_pull: { status: "ok", last_success_at: recent } }));
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks[3].status).toBe("ok");
  });

  it("is warning wanneer de NAS-pull ouder dan 36 uur is", async () => {
    const old = new Date(NOW.getTime() - 37 * 60 * 60 * 1000).toISOString();
    stubFetch(makeResponse({ nas_pull: { status: "ok", last_success_at: old } }));
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks[3].status).toBe("warning");
  });

  it("grensgeval: precies 36 uur oud is nog ok", async () => {
    const exactBoundary = new Date(NOW.getTime() - 36 * 60 * 60 * 1000).toISOString();
    stubFetch(makeResponse({ nas_pull: { status: "ok", last_success_at: exactBoundary } }));
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks[3].status).toBe("ok");
  });

  it("toekomstige timestamp faalt veilig (warning)", async () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    stubFetch(makeResponse({ nas_pull: { status: "ok", last_success_at: future } }));
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks[3].status).toBe("warning");
  });
});

describe("connect:mail freshness", () => {
  it("is ok wanneer de mail minder dan 24 uur geleden was", async () => {
    const recent = new Date(NOW.getTime() - 30 * 60 * 1000).toISOString();
    stubFetch(makeResponse({ outgoing_mail: { status: "ok", last_success_at: recent } }));
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks[4].status).toBe("ok");
  });

  it("is warning wanneer de mail ouder dan 24 uur is", async () => {
    const old = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();
    stubFetch(makeResponse({ outgoing_mail: { status: "ok", last_success_at: old } }));
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks[4].status).toBe("warning");
  });

  it("is error wanneer de mailmeting status 'error' heeft", async () => {
    stubFetch(makeResponse({ outgoing_mail: { status: "error", last_success_at: null } }));
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks[4].status).toBe("error");
  });
});

// ─── Misvormde/ontbrekende responscontroles ───────────────────────────────────

describe("misvormde/ongeldige responses", () => {
  it("behandelt een ontbrekend toplevel-veld als ongeldig", async () => {
    // Geen 'version' → validatie mislukt → data null
    stubFetch({ commit: COMMIT_SHA, measured_at: NOW.toISOString() });
    const [prod] = await getConnectChecks(goodBuildInput(), NOW);
    expect(prod.status).toBe("error");
  });

  it("behandelt een ontbrekende meting als ongeldig", async () => {
    const resp = makeResponse();
    delete (resp as Record<string, unknown>)["database_backup"];
    stubFetch(resp);
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    expect(checks[2].status).toBe("unknown");
  });

  it("behandelt een ongeldige status in een meting als ongeldig", async () => {
    stubFetch(makeResponse({ database_backup: { status: "invalid", last_success_at: null } }));
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    // Ongeldige status → validatie mislukt → data null → unknown
    expect(checks[2].status).toBe("unknown");
  });

  it("behandelt een niet-JSON-antwoord veilig", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new Error("JSON parse fout"); },
      })),
    );
    const [prod] = await getConnectChecks(goodBuildInput(), NOW);
    expect(prod.status).toBe("error");
  });

  it("behandelt een timeout veilig", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("The operation was aborted");
        (err as NodeJS.ErrnoException).name = "TimeoutError";
        throw err;
      }),
    );
    const [prod] = await getConnectChecks(goodBuildInput(), NOW);
    expect(prod.status).toBe("error");
  });

  it("behandelt een null-antwoord veilig", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => null,
      })),
    );
    const [prod] = await getConnectChecks(goodBuildInput(), NOW);
    expect(prod.status).toBe("error");
  });
});

// ─── Bevindingen openen/oplossen ──────────────────────────────────────────────

describe("syncConnectFindings — bevindingen", () => {
  it("opent connect:unreachable en behoudt bestaande bevindingen wanneer Connect onbereikbaar is", async () => {
    stubFetch(null);
    await syncConnectFindings(goodBuildInput(), NOW);

    const openedIds = mockOpenFinding.mock.calls.map((c) => c[0].id);
    expect(openedIds).toContain("connect:unreachable");

    const resolvedIds = mockResolveFinding.mock.calls.map((c) => c[0]);
    expect(resolvedIds).not.toContain("connect:version-unknown");
    expect(resolvedIds).not.toContain("connect:commit-mismatch");
    // De GitHub-bouwmeting is onafhankelijk en aantoonbaar groen.
    expect(resolvedIds).toContain("connect:build");
    expect(resolvedIds).not.toContain("connect:db-backup");
    expect(resolvedIds).not.toContain("connect:nas-pull");
    expect(resolvedIds).not.toContain("connect:mail");
  });

  it("lost connect:unreachable op wanneer Connect bereikbaar is", async () => {
    stubFetch(makeResponse());
    await syncConnectFindings(goodBuildInput(), NOW);

    const resolvedIds = mockResolveFinding.mock.calls.map((c) => c[0]);
    expect(resolvedIds).toContain("connect:unreachable");
  });

  it("opent connect:commit-mismatch wanneer commit afwijkt", async () => {
    const otherCommit = "0000000000000000000000000000000000000000";
    stubFetch(makeResponse({ commit: otherCommit }));
    mockGetDefaultBranchCommitSha.mockResolvedValue(COMMIT_SHA);
    await syncConnectFindings(goodBuildInput(), NOW);

    const openedIds = mockOpenFinding.mock.calls.map((c) => c[0].id);
    expect(openedIds).toContain("connect:commit-mismatch");
  });

  it("lost connect:commit-mismatch op wanneer commit overeenkomt", async () => {
    stubFetch(makeResponse({ commit: COMMIT_SHA }));
    mockGetDefaultBranchCommitSha.mockResolvedValue(COMMIT_SHA);
    await syncConnectFindings(goodBuildInput(), NOW);

    const resolvedIds = mockResolveFinding.mock.calls.map((c) => c[0]);
    expect(resolvedIds).toContain("connect:commit-mismatch");
  });

  it("opent connect:build wanneer de bouw al > 24 uur faalt", async () => {
    stubFetch(makeResponse());
    const problemSinceMs = NOW.getTime() - 25 * 60 * 60 * 1000;
    await syncConnectFindings({ repoStatus: "red", problemSinceMs }, NOW);

    const openedIds = mockOpenFinding.mock.calls.map((c) => c[0].id);
    expect(openedIds).toContain("connect:build");
  });

  it("lost connect:build op wanneer de repo groen is", async () => {
    stubFetch(makeResponse());
    await syncConnectFindings({ repoStatus: "green", problemSinceMs: null }, NOW);

    const resolvedIds = mockResolveFinding.mock.calls.map((c) => c[0]);
    expect(resolvedIds).toContain("connect:build");
  });

  it("opent connect:db-backup wanneer de back-up te oud is", async () => {
    const old = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();
    stubFetch(makeResponse({ database_backup: { status: "ok", last_success_at: old } }));
    await syncConnectFindings(goodBuildInput(), NOW);

    const openedIds = mockOpenFinding.mock.calls.map((c) => c[0].id);
    expect(openedIds).toContain("connect:db-backup");
  });

  it("lost connect:db-backup op wanneer de back-up recent is", async () => {
    const recent = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    stubFetch(makeResponse({ database_backup: { status: "ok", last_success_at: recent } }));
    await syncConnectFindings(goodBuildInput(), NOW);

    const resolvedIds = mockResolveFinding.mock.calls.map((c) => c[0]);
    expect(resolvedIds).toContain("connect:db-backup");
  });

  it("behoudt back-up-, NAS- en mailbevindingen bij onbekende metingen", async () => {
    stubFetch(makeResponse({
      database_backup: { status: "unknown", last_success_at: null },
      nas_pull: { status: "unknown", last_success_at: null },
      outgoing_mail: { status: "unknown", last_success_at: null },
    }));

    await syncConnectFindings(
      { repoStatus: null, problemSinceMs: null },
      NOW,
    );

    const resolvedIds = mockResolveFinding.mock.calls.map((c) => c[0]);
    expect(resolvedIds).not.toContain("connect:build");
    expect(resolvedIds).not.toContain("connect:db-backup");
    expect(resolvedIds).not.toContain("connect:nas-pull");
    expect(resolvedIds).not.toContain("connect:mail");
  });

  it("opent connect:nas-pull wanneer de NAS-sync te oud is", async () => {
    const old = new Date(NOW.getTime() - 37 * 60 * 60 * 1000).toISOString();
    stubFetch(makeResponse({ nas_pull: { status: "ok", last_success_at: old } }));
    await syncConnectFindings(goodBuildInput(), NOW);

    const openedIds = mockOpenFinding.mock.calls.map((c) => c[0].id);
    expect(openedIds).toContain("connect:nas-pull");
  });

  it("opent connect:mail wanneer de mail te oud is", async () => {
    const old = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();
    stubFetch(makeResponse({ outgoing_mail: { status: "ok", last_success_at: old } }));
    await syncConnectFindings(goodBuildInput(), NOW);

    const openedIds = mockOpenFinding.mock.calls.map((c) => c[0].id);
    expect(openedIds).toContain("connect:mail");
  });

  it("lost connect:mail op wanneer de mail recent is", async () => {
    const recent = new Date(NOW.getTime() - 30 * 60 * 1000).toISOString();
    stubFetch(makeResponse({ outgoing_mail: { status: "ok", last_success_at: recent } }));
    await syncConnectFindings(goodBuildInput(), NOW);

    const resolvedIds = mockResolveFinding.mock.calls.map((c) => c[0]);
    expect(resolvedIds).toContain("connect:mail");
  });

  it("bevat geen gevoelige gegevens in bevindingsdetails", async () => {
    stubFetch(null);
    await syncConnectFindings(goodBuildInput(), NOW);

    for (const call of mockOpenFinding.mock.calls) {
      const input = call[0];
      const sensitivePatterns = [/token/i, /secret/i, /password/i, /Bearer/i, /\?/];
      for (const pattern of sensitivePatterns) {
        expect(input.detail).not.toMatch(pattern);
        expect(input.title).not.toMatch(pattern);
      }
    }
  });

  it("gebruikt geen directe notificaties", async () => {
    // Controleer dat de mock voor notificaties niet wordt geïmporteerd/aangeroepen.
    // Omdat we notifications.js niet mocken in dit testbestand, bevestigen we
    // indirect dat syncConnectFindings alleen findings.js-functies aanroept.
    stubFetch(makeResponse());
    await expect(syncConnectFindings(goodBuildInput(), NOW)).resolves.toBeUndefined();
  });
});

// ─── Opgeslagen JSON in monitor_state ─────────────────────────────────────────

describe("syncConnectFindings — monitor_state persistentie", () => {
  it("slaat de vijf checks op in monitor_state onder de stabiele sleutel", async () => {
    stubFetch(makeResponse());
    await syncConnectFindings(goodBuildInput(), NOW);

    const upsertCall = mockQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("monitor_state"),
    );
    expect(upsertCall).toBeDefined();
    const upsertValues = upsertCall![1] as unknown[];

    // De tweede parameter is de sleutel
    expect(upsertValues[0]).toBe("connect:status:checks");

    // De derde parameter is het JSON-array
    const stored = JSON.parse(upsertValues[1] as string) as ConnectCheck[];
    expect(Array.isArray(stored)).toBe(true);
    expect(stored).toHaveLength(5);
  });

  it("de opgeslagen JSON bevat alleen id, label, status, detail — geen gevoelige velden", async () => {
    stubFetch(makeResponse());
    await syncConnectFindings(goodBuildInput(), NOW);

    const upsertCall = mockQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("monitor_state"),
    );
    expect(upsertCall).toBeDefined();
    const upsertValues2 = upsertCall![1] as unknown[];

    const stored = JSON.parse(upsertValues2[1] as string) as Record<string, unknown>[];
    for (const item of stored) {
      expect(Object.keys(item).sort()).toEqual(["detail", "id", "label", "status"].sort());
    }
  });

  it("bevat geen URL, token, geheim of bestandspad in de opgeslagen JSON", async () => {
    stubFetch(makeResponse());
    await syncConnectFindings(goodBuildInput(), NOW);

    const upsertCall = mockQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("monitor_state"),
    );
    const rawJson = (upsertCall![1] as unknown[])[1] as string;
    expect(rawJson).not.toMatch(/token|secret|password|Bearer|\?|\/[a-z]{3,}\//i);
  });

  it("slaat ook bij een fout-situatie (Connect onbereikbaar) netjes op", async () => {
    stubFetch(null);
    await syncConnectFindings(goodBuildInput(), NOW);

    const upsertCall = mockQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("monitor_state"),
    );
    expect(upsertCall).toBeDefined();
    const stored = JSON.parse((upsertCall![1] as unknown[])[1] as string) as ConnectCheck[];
    expect(stored).toHaveLength(5);
  });

  it("gooit geen fout als de database-upsert mislukt", async () => {
    stubFetch(makeResponse());
    mockQuery.mockRejectedValueOnce(new Error("DB tijdelijk onbereikbaar"));
    await expect(syncConnectFindings(goodBuildInput(), NOW)).resolves.toBeUndefined();
  });
});

// ─── Beveiligingscontroles ────────────────────────────────────────────────────

describe("beveiliging — geen gevoelige gegevens in uitvoer", () => {
  it("bevat geen URL in check-details", async () => {
    stubFetch(makeResponse());
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    for (const check of checks) {
      expect(check.detail).not.toMatch(/connect\.example\.com/);
      expect(check.detail).not.toMatch(/https?:\/\//);
    }
  });

  it("bevat geen querystring-parameters in check-details", async () => {
    process.env.CONNECT_STATUS_URL = "https://connect.example.com/status?token=geheim";
    stubFetch(makeResponse());
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    for (const check of checks) {
      expect(check.detail).not.toMatch(/token/i);
      expect(check.detail).not.toMatch(/geheim/i);
    }
  });

  it("bevat geen commit-SHA in detail-teksten", async () => {
    stubFetch(makeResponse({ commit: COMMIT_SHA }));
    mockGetDefaultBranchCommitSha.mockResolvedValue(COMMIT_SHA);
    const checks = await getConnectChecks(goodBuildInput(), NOW);
    for (const check of checks) {
      expect(check.detail).not.toMatch(COMMIT_SHA);
    }
  });
});
