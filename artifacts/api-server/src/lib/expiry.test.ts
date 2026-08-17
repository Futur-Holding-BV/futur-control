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

// Prevent the DB fallback (persistDomainExpiry / loadDomainExpiryFromDb) from
// leaking real database state between test runs.  The stub makes persist a
// harmless no-op and makes load always return an empty result set.
vi.mock("@workspace/db", () => ({
  db: {
    insert: () => ({ onConflictDoUpdate: () => Promise.resolve() }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }),
  },
  domainExpiryCache: {},
}));
// drizzle-orm is used only for the `eq` helper inside loadDomainExpiryFromDb.
vi.mock("drizzle-orm", () => ({ eq: () => undefined }));

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

describe(".nl-domein — handmatig invoer (EXPIRY_MANUAL)", () => {
  const NL_DOMAIN = "voorbeeld.nl";
  let listExpiryItems: Awaited<ReturnType<typeof freshExpiry>>["listExpiryItems"];

  beforeAll(async () => {
    // Isolate env but override EXPIRY_DOMAINS to a .nl domain.
    isolateEnv();
    process.env.EXPIRY_DOMAINS = NL_DOMAIN;
    ({ listExpiryItems } = await freshExpiry());
  });
  afterAll(() => {
    delete process.env.EXPIRY_MANUAL;
    restoreEnv();
  });
  afterEach(() => vi.restoreAllMocks());

  it("geeft severity unknown als het .nl-domein niet in EXPIRY_MANUAL staat", async () => {
    delete process.env.EXPIRY_MANUAL;
    // Fetch should never be called for RDAP — the .nl branch short-circuits.
    const spy = stubFetch(() => { throw new Error("should not be called for .nl"); });

    const items = await listExpiryItems(true);
    const domain = items.find((i) => i.id === `domain:${NL_DOMAIN}`);

    // No RDAP call expected.
    const rdapCalls = spy.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      return url.includes("rdap.org");
    });
    expect(rdapCalls).toHaveLength(0);

    expect(domain).toBeDefined();
    expect(domain!.severity).toBe("unknown");
    expect(domain!.expiresAt).toBeNull();
    expect(domain!.staleNote).toBeNull();
    // The instructive message must mention EXPIRY_MANUAL so the operator knows what to do.
    expect(domain!.unknownReason).toMatch(/EXPIRY_MANUAL/);
  });

  it("geeft een bekende datum als het .nl-domein wél in EXPIRY_MANUAL staat", async () => {
    process.env.EXPIRY_MANUAL = `${NL_DOMAIN}=2030-06-14`;
    const spy = stubFetch(() => { throw new Error("should not be called for .nl"); });

    const items = await listExpiryItems(true);
    const domain = items.find((i) => i.id === `domain:${NL_DOMAIN}`);

    // No RDAP call expected.
    const rdapCalls = spy.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      return url.includes("rdap.org");
    });
    expect(rdapCalls).toHaveLength(0);

    expect(domain).toBeDefined();
    expect(domain!.severity).not.toBe("unknown");
    expect(domain!.expiresAt).toBeTruthy();
    expect(domain!.staleNote).toBeNull();
    // Label must indicate the date was entered manually.
    expect(domain!.label).toMatch(/handmatig/i);
  });

  it("geeft severity unknown als EXPIRY_MANUAL een ongeldige datum bevat voor het .nl-domein", async () => {
    // Typo: "niet-een-datum" is not a valid date → parseManualExpiries warns and tracks it.
    process.env.EXPIRY_MANUAL = `${NL_DOMAIN}=niet-een-datum`;
    stubFetch(() => { throw new Error("should not be called for .nl"); });

    const items = await listExpiryItems(true);
    const domain = items.find((i) => i.id === `domain:${NL_DOMAIN}`);

    expect(domain).toBeDefined();
    expect(domain!.severity).toBe("unknown");
    expect(domain!.expiresAt).toBeNull();
    // The message must reference EXPIRY_MANUAL and distinguish this from a missing entry.
    expect(domain!.unknownReason).toMatch(/EXPIRY_MANUAL/);
    expect(domain!.unknownReason).toMatch(/datum kon niet worden gelezen/);
  });

  it("geeft severity unknown als EXPIRY_MANUAL een onmogelijke kalenderdate bevat (bv. 2024-02-30)", async () => {
    // JS normalises 2024-02-30 to 2024-03-01 — strict round-trip validation must catch this.
    process.env.EXPIRY_MANUAL = `${NL_DOMAIN}=2024-02-30`;
    stubFetch(() => { throw new Error("should not be called for .nl"); });

    const items = await listExpiryItems(true);
    const domain = items.find((i) => i.id === `domain:${NL_DOMAIN}`);

    expect(domain).toBeDefined();
    expect(domain!.severity).toBe("unknown");
    expect(domain!.expiresAt).toBeNull();
    expect(domain!.unknownReason).toMatch(/EXPIRY_MANUAL/);
    expect(domain!.unknownReason).toMatch(/datum kon niet worden gelezen/);
  });

  it("geeft severity unknown als EXPIRY_MANUAL een niet-canonieke datum bevat (bv. 2024-2-1)", async () => {
    // Non-canonical format (single-digit month/day) must also be rejected.
    process.env.EXPIRY_MANUAL = `${NL_DOMAIN}=2024-2-1`;
    stubFetch(() => { throw new Error("should not be called for .nl"); });

    const items = await listExpiryItems(true);
    const domain = items.find((i) => i.id === `domain:${NL_DOMAIN}`);

    expect(domain).toBeDefined();
    expect(domain!.severity).toBe("unknown");
    expect(domain!.expiresAt).toBeNull();
    expect(domain!.unknownReason).toMatch(/EXPIRY_MANUAL/);
    expect(domain!.unknownReason).toMatch(/datum kon niet worden gelezen/);
  });

  it("loggt een waarschuwing als EXPIRY_MANUAL een ongeldige datum bevat", async () => {
    process.env.EXPIRY_MANUAL = `${NL_DOMAIN}=niet-een-datum`;
    stubFetch(() => { throw new Error("should not be called for .nl"); });

    // Spy on the logger that the already-imported expiry module uses.
    // Both were imported in the same vi.resetModules() → import cycle in beforeAll,
    // so they share the same module instance.
    const { logger } = await import("./logger.js");
    const warnSpy = vi.spyOn(logger, "warn");

    await listExpiryItems(true);

    const malformedWarning = warnSpy.mock.calls.find(([obj]) =>
      typeof obj === "object" && obj !== null && "entry" in obj,
    );
    expect(malformedWarning).toBeDefined();
  });

  it("onderscheidt 'geen vermelding' van 'ongeldige datum' in unknownReason", async () => {
    // parseManualExpiries() reads process.env at call time, so changing the env
    // between bypassCache=true calls is sufficient — no module reset needed.

    // Check the no-entry message.
    delete process.env.EXPIRY_MANUAL;
    stubFetch(() => { throw new Error("should not be called for .nl"); });

    const itemsNoEntry = await listExpiryItems(true);
    const noEntry = itemsNoEntry.find((i) => i.id === `domain:${NL_DOMAIN}`);
    expect(noEntry!.unknownReason).not.toMatch(/datum kon niet worden gelezen/);
    expect(noEntry!.unknownReason).toMatch(/EXPIRY_MANUAL/);

    // Check the malformed-date message.
    process.env.EXPIRY_MANUAL = `${NL_DOMAIN}=ongeldige-datum`;
    const itemsMalformed = await listExpiryItems(true);
    const malformed = itemsMalformed.find((i) => i.id === `domain:${NL_DOMAIN}`);
    expect(malformed!.unknownReason).toMatch(/datum kon niet worden gelezen/);
    expect(malformed!.unknownReason).toMatch(/EXPIRY_MANUAL/);
  });

  it("geen kruisbesmetting: geldig EXPIRY_MANUAL-item voor een ander domein laat het .nl-domein onbekend", async () => {
    // Only "anders.nl" has a valid entry; NL_DOMAIN ("voorbeeld.nl") is absent.
    process.env.EXPIRY_MANUAL = `anders.nl=2030-06-14`;
    stubFetch(() => { throw new Error("should not be called for .nl"); });

    const items = await listExpiryItems(true);
    const domain = items.find((i) => i.id === `domain:${NL_DOMAIN}`);

    expect(domain).toBeDefined();
    expect(domain!.severity).toBe("unknown");
    expect(domain!.expiresAt).toBeNull();
    // The message must reference EXPIRY_MANUAL so the operator knows what to do.
    expect(domain!.unknownReason).toMatch(/EXPIRY_MANUAL/);
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
