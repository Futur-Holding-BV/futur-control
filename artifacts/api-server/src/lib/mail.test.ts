/**
 * Tests for the Microsoft Graph mail channel:
 *   • token cache — never a fresh token per message
 *   • missing configuration logs once and disables only the mail channel
 *   • failed sends land in the outbox and are retried
 *   • after the upper bound the failure is loudly logged, never silent
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const inserted: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];
const stateQueries: Array<{ text: string; values?: unknown[] }> = [];
let deletes = 0;
let insertFails = false;
let stateQueryFails = false;
let selectRows: Array<Record<string, unknown>> = [];

vi.mock("@workspace/db", () => ({
  pool: {
    query: async (text: string, values?: unknown[]) => {
      stateQueries.push({ text, values });
      if (stateQueryFails) throw new Error("state write failed");
      return { rows: [], rowCount: 1 };
    },
  },
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => selectRows }),
        orderBy: async () => selectRows,
      }),
    }),
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        if (insertFails) throw new Error("db down");
        inserted.push(v);
      },
    }),
    update: () => ({
      set: (s: Record<string, unknown>) => ({
        where: async () => {
          updates.push(s);
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        deletes += 1;
      },
    }),
  },
  mailOutbox: { id: "id", subject: "subject", body: "body" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => undefined,
  sql: () => undefined,
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./actionlog.js", () => ({
  logAction: vi.fn(async () => 1),
}));

import {
  sendMailSafe,
  sendMailDirect,
  retryMailOutbox,
  resetMailStateForTests,
  isMailConfigured,
  MAX_OUTBOX_ATTEMPTS,
} from "./mail.js";
import { logger } from "./logger.js";
import { logAction } from "./actionlog.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenResponse(expiresIn = 3600): Response {
  return new Response(
    JSON.stringify({ access_token: "tok-123", expires_in: expiresIn }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function acceptedResponse(): Response {
  return new Response(null, { status: 202 });
}

function errorResponse(status: number, body = "boom"): Response {
  return new Response(body, { status });
}

const originalEnv = { ...process.env };

function setMailEnv(): void {
  process.env["GRAPH_TENANT_ID"] = "tenant-1";
  process.env["GRAPH_CLIENT_ID"] = "client-1";
  process.env["GRAPH_CLIENT_SECRET"] = "secret-1";
  process.env["MAIL_FROM"] = "monitor@example.com";
  process.env["MAIL_TO"] = "a@example.com, b@example.com";
}

function clearMailEnv(): void {
  delete process.env["GRAPH_TENANT_ID"];
  delete process.env["GRAPH_CLIENT_ID"];
  delete process.env["GRAPH_CLIENT_SECRET"];
  delete process.env["MAIL_FROM"];
  delete process.env["MAIL_TO"];
}

beforeEach(() => {
  resetMailStateForTests();
  inserted.length = 0;
  updates.length = 0;
  stateQueries.length = 0;
  deletes = 0;
  insertFails = false;
  stateQueryFails = false;
  selectRows = [];
  setMailEnv();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("mail configuration", () => {
  it("logs the missing configuration exactly once and returns false", async () => {
    clearMailEnv();
    expect(isMailConfigured()).toBe(false);

    const r1 = await sendMailSafe("s1", "b1");
    const r2 = await sendMailSafe("s2", "b2");

    expect(r1).toBe("off");
    expect(r2).toBe("off");
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    // Nothing queued, nothing sent.
    expect(inserted).toHaveLength(0);
  });

  it("splits MAIL_TO on commas into multiple recipients", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(acceptedResponse());

    await sendMailDirect("subject", "body");

    const [, init] = fetchSpy.mock.calls[1]!;
    const payload = JSON.parse((init as RequestInit).body as string) as {
      message: { toRecipients: Array<{ emailAddress: { address: string } }> };
    };
    expect(payload.message.toRecipients.map((r) => r.emailAddress.address)).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

describe("token cache", () => {
  it("fetches the token once and reuses it for subsequent mails", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(acceptedResponse())
      .mockResolvedValueOnce(acceptedResponse());

    await sendMailDirect("first", "body");
    await sendMailDirect("second", "body");

    // 3 calls total: 1 token + 2 sendMail — NOT a token per message.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const tokenCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes("login.microsoftonline.com"),
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it("refreshes the token when it is about to expire", async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(tokenResponse(120)) // expires in 2 min
        .mockResolvedValueOnce(acceptedResponse())
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(acceptedResponse());

      await sendMailDirect("first", "body");
      // Advance past expiry minus the 60 s margin.
      vi.advanceTimersByTime(90_000);
      await sendMailDirect("second", "body");

      const tokenCalls = fetchSpy.mock.calls.filter(([url]) =>
        String(url).includes("login.microsoftonline.com"),
      );
      expect(tokenCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

describe("outbox", () => {
  it("queues a failed send with the error message and returns 'queued'", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(errorResponse(500, "graph down"));

    const result = await sendMailSafe("subject", "body");

    expect(result).toBe("queued");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ subject: "subject", body: "body", attempts: 1 });
    expect(String(inserted[0]!["lastError"])).toContain("500");
  });

  it("returns 'failed' when the send fails AND queueing fails — nothing persisted", async () => {
    insertFails = true;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(errorResponse(500));

    const result = await sendMailSafe("subject", "body");

    expect(result).toBe("failed");
    expect(inserted).toHaveLength(0);
  });

  it("does not queue a duplicate of an identical pending mail", async () => {
    selectRows = [{ id: 7 }]; // identical mail already queued
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(errorResponse(500));

    const result = await sendMailSafe("subject", "body");

    expect(result).toBe("queued");
    expect(inserted).toHaveLength(0);
    expect(updates).toHaveLength(1); // error refreshed on the existing row
  });

  it("failed initial send → queued → successful outbox retry → no second mail", async () => {
    // Poll 1: notification fires, Graph is down — mail lands in the outbox.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(errorResponse(500))
      // Poll 2: outbox retry — Graph is back (token still cached).
      .mockResolvedValueOnce(acceptedResponse());

    const result = await sendMailSafe("s", "b");
    expect(result).toBe("queued"); // caller advances notified-state → no resend

    // Poll 2: the monitor only runs the outbox retry for this mail.
    selectRows = [{ id: 1, subject: "s", body: "b", attempts: 1 }];
    await retryMailOutbox();

    expect(deletes).toBe(1); // delivered and removed
    // Exactly one sendMail per poll: 1 failed + 1 successful — never two
    // deliveries of the same notification.
    const sendCalls = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([url]) => String(url).includes("graph.microsoft.com"));
    expect(sendCalls).toHaveLength(2);
  });

  it("retries queued mails and removes them on success", async () => {
    selectRows = [{ id: 1, subject: "s", body: "b", attempts: 2 }];
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(acceptedResponse());

    await retryMailOutbox();

    expect(deletes).toBe(1);
    expect(vi.mocked(logAction)).not.toHaveBeenCalled();
  });

  it("marks a queued daily report as confirmed when Graph accepts the retry", async () => {
    selectRows = [{
      id: 1,
      subject: "📋 Dagbericht 2026-08-18: bewaking draait",
      body: "De bewaking draait.",
      attempts: 2,
    }];
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(acceptedResponse());

    await retryMailOutbox();

    expect(stateQueries).toHaveLength(1);
    expect(stateQueries[0]?.text).toContain("daily-report");
    expect(stateQueries[0]?.values).toEqual(["2026-08-18"]);
    expect(deletes).toBe(1);
  });

  it("retries only confirmation state when Graph accepted but its state write failed", async () => {
    const subject = "📋 Dagbericht 2026-08-18: bewaking draait";
    selectRows = [{
      id: 1,
      subject,
      body: "De bewaking draait.",
      lastError: "graph down",
      attempts: 2,
    }];
    stateQueryFails = true;
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(acceptedResponse());

    await retryMailOutbox();

    expect(deletes).toBe(0);
    expect(updates.at(-1)).toMatchObject({
      lastError: "daily-report-accepted:2026-08-18",
    });
    expect(fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes("graph.microsoft.com"))).toHaveLength(1);

    stateQueryFails = false;
    selectRows = [{
      id: 1,
      subject,
      body: "De bewaking draait.",
      lastError: "daily-report-accepted:2026-08-18",
      attempts: 2,
    }];
    await retryMailOutbox();

    expect(deletes).toBe(1);
    expect(fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes("graph.microsoft.com"))).toHaveLength(1);
  });

  it("bumps the attempt counter when the retry fails again", async () => {
    selectRows = [{ id: 1, subject: "s", body: "b", attempts: 2 }];
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(errorResponse(500));

    await retryMailOutbox();

    expect(deletes).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ attempts: 3 });
  });

  it("loudly logs to the action log after the upper bound — never silent", async () => {
    selectRows = [
      { id: 1, subject: "s", body: "b", attempts: MAX_OUTBOX_ATTEMPTS - 1 },
    ];
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(errorResponse(500));

    await retryMailOutbox();

    expect(vi.mocked(logAction)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logAction).mock.calls[0]![0]).toMatchObject({
      kind: "mail_mislukt",
    });
    expect(deletes).toBe(1); // removed only after the loud log entry
  });

  it("does nothing when mail is not configured", async () => {
    clearMailEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await retryMailOutbox();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
