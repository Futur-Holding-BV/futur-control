import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  openFinding: vi.fn(),
  resolveFinding: vi.fn(),
  poolQuery: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  pool: {
    connect: mocks.connect,
    query: mocks.poolQuery,
  },
}));

vi.mock("./findings.js", () => ({
  openFinding: mocks.openFinding,
  resolveFinding: mocks.resolveFinding,
}));

import {
  registreerSentrySignaal,
} from "./sentryRouter.js";

const GEHEIM = "test-router-geheim-met-minstens-32-tekens";
const VERWIJZINGSCODE = "FPS-3A9C1B04";
const HANDELING = "POST:/api/uren";
const BEWIJS = createHmac("sha256", GEHEIM)
  .update(`${VERWIJZINGSCODE}:${HANDELING}`)
  .digest("hex");

function resultaat(
  rows: Record<string, unknown>[] = [],
  rowCount = rows.length,
): { rows: Record<string, unknown>[]; rowCount: number } {
  return { rows, rowCount };
}

describe("Sentry-router claims en idempotentie", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["SENTRY_ROUTING_SIGNING_SECRET"] = GEHEIM;
    process.env["SENTRY_DIRECT_API_PROJECT"] = "fps-connect-api";
  });

  it("telt een webhookretry zonder nieuwe eventclaim niet opnieuw", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return resultaat();
      if (sql.includes("INSERT INTO sentry_router_events")) return resultaat();
      throw new Error(`Onverwachte query in retryproef: ${sql}`);
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });

    await registreerSentrySignaal({
      issueKey: "12345",
      eventKey: "0123456789abcdef0123456789abcdef",
      project: "fps-connect-api",
      component: "api",
      handeling: HANDELING,
      omgeving: "production",
      release: "abcdef1",
      verwijzingscode: VERWIJZINGSCODE,
      routingBewijs: BEWIJS,
      issueUrl: "https://futur-holding.sentry.io/issues/12345/",
    });

    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO sentry_router_issues")
    )).toBe(false);
  });

  it("zet een tweemaal waargenomen fout in het centrale dagbericht", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") return resultaat();
      if (sql.includes("INSERT INTO sentry_router_events")) {
        return resultaat([{ event_key: "event" }]);
      }
      if (sql.includes("INSERT INTO sentry_router_issues")) {
        return resultaat([{ aantal: 2 }]);
      }
      return resultaat();
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });

    await registreerSentrySignaal({
      issueKey: "12345",
      eventKey: "0123456789abcdef0123456789abcdef",
      project: "fps-connect-api",
      component: "api",
      handeling: "GET:/api/projecten",
      omgeving: "production",
      release: "abcdef1",
      verwijzingscode: null,
      routingBewijs: null,
      issueUrl: "https://futur-holding.sentry.io/issues/12345/",
    });

    expect(mocks.openFinding).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "sentry:12345",
        kind: "sentry_error",
        subject: "fps-connect-api",
      }),
    );
  });

  it("zet een vertrouwde directe fout in de centrale directe stroom", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") return resultaat();
      if (sql.includes("INSERT INTO sentry_router_events")) {
        return resultaat([{ event_key: "event" }]);
      }
      if (sql.includes("INSERT INTO sentry_router_issues")) {
        return resultaat([{ aantal: 2 }]);
      }
      return resultaat();
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });

    await registreerSentrySignaal({
      issueKey: "12345",
      eventKey: "0123456789abcdef0123456789abcdef",
      project: "fps-connect-api",
      component: "api",
      handeling: HANDELING,
      omgeving: "production",
      release: "abcdef1",
      verwijzingscode: VERWIJZINGSCODE,
      routingBewijs: BEWIJS,
      issueUrl: "https://futur-holding.sentry.io/issues/12345/",
    });

    expect(mocks.openFinding).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "sentry:12345",
        kind: "sentry_direct",
      }),
    );
  });

  it("rolt de eventclaim terug wanneer de centrale bevinding faalt", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return resultaat();
      if (sql.includes("INSERT INTO sentry_router_events")) {
        return resultaat([{ event_key: "event" }]);
      }
      if (sql.includes("INSERT INTO sentry_router_issues")) {
        return resultaat([{ aantal: 2 }]);
      }
      return resultaat();
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });
    mocks.openFinding.mockRejectedValueOnce(new Error("finding-opslag tijdelijk onbereikbaar"));

    await expect(registreerSentrySignaal({
      issueKey: "12345",
      eventKey: "0123456789abcdef0123456789abcdef",
      project: "fps-connect-api",
      component: "api",
      handeling: HANDELING,
      omgeving: "production",
      release: "abcdef1",
      verwijzingscode: VERWIJZINGSCODE,
      routingBewijs: BEWIJS,
      issueUrl: "https://futur-holding.sentry.io/issues/12345/",
    })).rejects.toThrow("finding-opslag");

    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query).not.toHaveBeenCalledWith("COMMIT");
  });
});