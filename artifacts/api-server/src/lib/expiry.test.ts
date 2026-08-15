/**
 * Unit tests for domain-expiry stale fallback, 429 backoff, and cache expiry.
 *
 * Each describe block resets the module to get a clean in-memory state for
 * domainLastKnown and rdapBackoffUntil (both module-level Maps).
 *
 * External dependencies are controlled through fetch mocking. Env vars for
 * GitHub token, TLS hosts, and Azure are left unset so only the RDAP fetch
 * is triggered, keeping tests focused.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DOMAIN = "example.com";
const FAR_FUTURE = "2030-06-01T00:00:00Z";

function rdapOk(expiryDate = FAR_FUTURE): Response {
  return new Response(
    JSON.stringify({ events: [{ eventAction: "expiration", eventDate: expiryDate }] }),
    { status: 200, headers: { "Content-Type": "application/rdap+json" } },
  );
}

function rdap429(retryAfterSeconds = "3600"): Response {
  return new Response("Too Many Requests", {
    status: 429,
    headers: { "Retry-After": retryAfterSeconds },
  });
}

function rdap503(): Response {
  return new Response("Service Unavailable", { status: 503 });
}

/** Stubs fetch: RDAP calls are handled by `rdapHandler`; everything else returns 200/{}. */
function stubFetch(rdapHandler: () => Response | Promise<Response>) {
  return vi.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("rdap.org")) return rdapHandler();
    // GitHub rate_limit → 200 with no expiry header → "unknown" for token items
    return new Response("{}", { status: 200 });
  });
}

/** Imports a fresh copy of expiry.ts with clean module-level state. */
async function freshExpiry() {
  vi.resetModules();
  return import("./expiry.js");
}

// Unset env vars that would trigger non-RDAP external calls, keeping tests fast.
const savedEnv: Record<string, string | undefined> = {};
function isolateEnv() {
  const keys = ["GITHUB_TOKEN", "GITHUB_PUSH_TOKEN", "EXPIRY_TLS_HOSTS", "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];
  for (const k of keys) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.EXPIRY_DOMAINS = DOMAIN;
}
function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete process.env.EXPIRY_DOMAINS;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("domeinverloopdatum — geen cache, RDAP mislukt", () => {
  let listExpiryItems: Awaited<ReturnType<typeof freshExpiry>>["listExpiryItems"];

  beforeAll(async () => {
    isolateEnv();
    ({ listExpiryItems } = await freshExpiry());
  });
  afterAll(restoreEnv);
  afterEach(() => vi.restoreAllMocks());

  it("geeft severity unknown als RDAP een netwerkfout geeft en er geen cache is", async () => {
    stubFetch(() => { throw new Error("network error"); });

    const items = await listExpiryItems(/* bypassCache */ true);
    const domain = items.find((i) => i.id === `domain:${DOMAIN}`);

    expect(domain).toBeDefined();
    expect(domain!.severity).toBe("unknown");
    expect(domain!.expiresAt).toBeNull();
    expect(domain!.staleNote).toBeNull();
  });

  it("geeft severity unknown als RDAP status 503 teruggeeft en er geen cache is", async () => {
    stubFetch(rdap503);

    const items = await listExpiryItems(true);
    const domain = items.find((i) => i.id === `domain:${DOMAIN}`);

    expect(domain!.severity).toBe("unknown");
    expect(domain!.staleNote).toBeNull();
  });
});

describe("domeinverloopdatum — stale fallback na 429", () => {
  let listExpiryItems: Awaited<ReturnType<typeof freshExpiry>>["listExpiryItems"];

  beforeAll(async () => {
    isolateEnv();
    ({ listExpiryItems } = await freshExpiry());
  });
  afterAll(restoreEnv);
  afterEach(() => vi.restoreAllMocks());

  it("slaat de verloopdatum op bij een succesvolle RDAP-aanroep", async () => {
    stubFetch(rdapOk);

    const items = await listExpiryItems(true);
    const domain = items.find((i) => i.id === `domain:${DOMAIN}`);

    expect(domain!.severity).not.toBe("unknown");
    expect(domain!.expiresAt).toBeTruthy();
    expect(domain!.staleNote).toBeNull();
  });

  it("toont de gecachte datum met staleNote als RDAP daarna 429 teruggeeft", async () => {
    // RDAP was already called successfully in the previous test → cache is set.
    stubFetch(rdap429);

    const items = await listExpiryItems(true);
    const domain = items.find((i) => i.id === `domain:${DOMAIN}`);

    expect(domain!.severity).not.toBe("unknown");
    expect(domain!.expiresAt).toBeTruthy();
    expect(domain!.staleNote).toMatch(/op basis van meting van/);
    expect(domain!.staleNote).toMatch(/429/);
  });

  it("slaat het domein tijdelijk over (backoff) als RDAP 429 geeft", async () => {
    // Previous test set the backoff for the domain.  Mock would never be called
    // for the RDAP URL while inside the backoff window.
    const spy = stubFetch(() => { throw new Error("should not be called"); });

    const items = await listExpiryItems(true);
    const domain = items.find((i) => i.id === `domain:${DOMAIN}`);

    // Fetch should NOT have been called for RDAP (request skipped due to backoff).
    const rdapCalls = spy.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      return url.includes("rdap.org");
    });
    expect(rdapCalls).toHaveLength(0);

    // But stale data is still shown.
    expect(domain!.severity).not.toBe("unknown");
    expect(domain!.staleNote).toMatch(/tijdelijk overbelast/);
  });
});

describe("domeinverloopdatum — stale fallback na netwerkfout", () => {
  let listExpiryItems: Awaited<ReturnType<typeof freshExpiry>>["listExpiryItems"];

  beforeAll(async () => {
    isolateEnv();
    ({ listExpiryItems } = await freshExpiry());
  });
  afterAll(restoreEnv);
  afterEach(() => vi.restoreAllMocks());

  it("slaat de verloopdatum op bij succesvol RDAP-verzoek", async () => {
    stubFetch(rdapOk);
    const items = await listExpiryItems(true);
    const domain = items.find((i) => i.id === `domain:${DOMAIN}`);
    expect(domain!.severity).not.toBe("unknown");
  });

  it("toont gecachte datum met staleNote bij netwerkfout na succesvolle meting", async () => {
    stubFetch(() => { throw new Error("network error"); });

    const items = await listExpiryItems(true);
    const domain = items.find((i) => i.id === `domain:${DOMAIN}`);

    expect(domain!.severity).not.toBe("unknown");
    expect(domain!.expiresAt).toBeTruthy();
    expect(domain!.staleNote).toMatch(/op basis van meting van/);
  });
});

describe("domeinverloopdatum — cache ouder dan 7 dagen", () => {
  let listExpiryItems: Awaited<ReturnType<typeof freshExpiry>>["listExpiryItems"];

  beforeAll(async () => {
    isolateEnv();
    vi.useFakeTimers();
    ({ listExpiryItems } = await freshExpiry());
  });
  afterAll(() => {
    vi.useRealTimers();
    restoreEnv();
  });
  afterEach(() => vi.restoreAllMocks());

  it("toont unknown als de cache ouder is dan 7 dagen en RDAP mislukt", async () => {
    // Populate the cache at t=0.
    stubFetch(rdapOk);
    await listExpiryItems(true);
    vi.restoreAllMocks();

    // Advance time 8 days — cache is now stale.
    vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000);

    stubFetch(rdap503);
    const items = await listExpiryItems(true);
    const domain = items.find((i) => i.id === `domain:${DOMAIN}`);

    // Cache is too old → must not use stale data.
    expect(domain!.severity).toBe("unknown");
    expect(domain!.staleNote).toBeNull();
  });
});
