import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  notifyDagbundel: vi.fn(),
  notifyDirect: vi.fn(),
  poolQuery: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  pool: {
    connect: mocks.connect,
    query: mocks.poolQuery,
  },
}));

vi.mock("./notifications.js", () => ({
  notifySentryDagbundel: mocks.notifyDagbundel,
  notifySentryDirect: mocks.notifyDirect,
}));

import {
  registreerSentrySignaal,
  verwerkSentryMeldingen,
} from "./sentryRouter.js";

const GEHEIM = "test-router-geheim-met-minstens-32-tekens";
const VERWIJZINGSCODE = "FPS-3A9C1B04";
const HANDELING = "POST:/api/uren";
const BEWIJS = createHmac("sha256", GEHEIM)
  .update(`${VERWIJZINGSCODE}:${HANDELING}`)
  .digest("hex");

const RIJ = {
  issue_key: "12345",
  project: "fps-connect-api",
  component: "api",
  handeling: HANDELING,
  omgeving: "production",
  release: "abcdef1",
  verwijzingscode: VERWIJZINGSCODE,
  routing_bewijs: BEWIJS,
  issue_url: "https://futur-holding.sentry.io/issues/12345/",
  aantal: 2,
};

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

  it("verstuurt niets wanneer resolve de conditionele claim vóór is", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) {
        return resultaat([{ acquired: true }]);
      }
      if (sql.includes("SELECT issue_key")) return resultaat([RIJ]);
      if (sql.includes("SET meld_claim_token = $2")) {
        // PostgreSQL geeft nul rijen terug wanneer opgelost_op inmiddels gezet
        // is; er bestaat daarna geen los select-naar-netwerk-racevenster.
        return resultaat();
      }
      return resultaat();
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });

    await verwerkSentryMeldingen(new Date("2026-08-20T06:00:00Z"));

    expect(mocks.notifyDirect).not.toHaveBeenCalled();
    expect(mocks.notifyDagbundel).not.toHaveBeenCalled();
  });

  it("verstuurt uitsluitend na een geslaagde atomische claim", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) {
        return resultaat([{ acquired: true }]);
      }
      if (sql.includes("SELECT issue_key")) return resultaat([RIJ]);
      if (sql.includes("SET meld_claim_token = $2")) return resultaat([RIJ]);
      return resultaat();
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });
    mocks.notifyDirect.mockResolvedValue(true);

    await verwerkSentryMeldingen(new Date("2026-08-20T06:00:00Z"));

    expect(mocks.notifyDirect).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("SET gemeld_op = NOW()")
    )).toBe(true);
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
});