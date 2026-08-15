/**
 * "Loopt af" — collects everything with an expiry date:
 *   • GitHub tokens (read token + optional push token) via the
 *     github-authentication-token-expiration response header
 *   • TLS certificates of running environments (EXPIRY_TLS_HOSTS)
 *   • Azure client key of FPS Connect (via Microsoft Graph, when
 *     AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET are set)
 *   • Domain renewal dates via public RDAP (EXPIRY_DOMAINS)
 *
 * Anything that cannot be read is reported as severity "unknown" with the
 * reason — never as ok.
 */

import tls from "node:tls";
import { logger } from "./logger.js";

export type ExpirySeverity = "red" | "orange" | "ok" | "unknown";

export interface ExpiryItem {
  id: string;
  label: string;
  category: "github_token" | "tls_certificate" | "azure_key" | "domain";
  expiresAt: string | null;
  daysLeft: number | null;
  severity: ExpirySeverity;
  consequence: string;
  unknownReason: string | null;
  /** Set when the expiry date comes from a cached previous reading (RDAP temporarily unavailable) */
  staleNote: string | null;
}

const CACHE_TTL_MS = 30 * 60 * 1000;
let cached: { items: ExpiryItem[]; expiresAt: number } | null = null;

const DAY_MS = 24 * 60 * 60 * 1000;

function severityFor(expiresAt: Date): ExpirySeverity {
  const days = (expiresAt.getTime() - Date.now()) / DAY_MS;
  if (days <= 7) return "red";
  if (days <= 30) return "orange";
  return "ok";
}

function daysLeft(expiresAt: Date): number {
  return Math.floor((expiresAt.getTime() - Date.now()) / DAY_MS);
}

function known(
  base: Omit<ExpiryItem, "expiresAt" | "daysLeft" | "severity" | "unknownReason" | "staleNote">,
  expiresAt: Date,
  staleNote: string | null = null,
): ExpiryItem {
  return {
    ...base,
    expiresAt: expiresAt.toISOString(),
    daysLeft: daysLeft(expiresAt),
    severity: severityFor(expiresAt),
    unknownReason: null,
    staleNote,
  };
}

function unknown(
  base: Omit<ExpiryItem, "expiresAt" | "daysLeft" | "severity" | "unknownReason" | "staleNote">,
  reason: string,
): ExpiryItem {
  return {
    ...base,
    expiresAt: null,
    daysLeft: null,
    severity: "unknown",
    unknownReason: reason,
    staleNote: null,
  };
}

function redAlert(
  base: Omit<ExpiryItem, "expiresAt" | "daysLeft" | "severity" | "unknownReason" | "staleNote">,
  reason: string,
): ExpiryItem {
  return {
    ...base,
    expiresAt: null,
    daysLeft: null,
    severity: "red",
    unknownReason: reason,
    staleNote: null,
  };
}

// ── GitHub tokens ────────────────────────────────────────────────────────────

/**
 * GitHub reports the token expiry in the
 * `github-authentication-token-expiration` header on any API response
 * (fine-grained tokens and classic tokens with an expiry date).
 */
async function githubTokenExpiry(token: string): Promise<Date | null | "invalid"> {
  const res = await fetch("https://api.github.com/rate_limit", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (res.status === 401) return "invalid";
  const header = res.headers.get("github-authentication-token-expiration");
  if (!header) return null;
  // Format is e.g. "2026-10-01 12:00:00 UTC" or ISO 8601.
  const normalized = header.replace(" UTC", "Z").replace(" ", "T");
  const date = new Date(normalized);
  return isNaN(date.getTime()) ? null : date;
}

async function githubTokenItem(
  id: string,
  label: string,
  consequence: string,
  token: string | undefined,
  missingReason: string,
): Promise<ExpiryItem> {
  const base = { id, label, category: "github_token" as const, consequence };
  if (!token) return unknown(base, missingReason);
  try {
    const result = await githubTokenExpiry(token);
    if (result === "invalid")
      return unknown(base, "het token wordt door GitHub geweigerd (ongeldig of al verlopen)");
    if (result === null)
      return unknown(
        base,
        "GitHub meldt geen einddatum voor dit token (klassiek token zonder vervaldatum)",
      );
    return known(base, result);
  } catch (err) {
    logger.warn({ err, id }, "Tokencontrole mislukt");
    return unknown(base, "GitHub was niet bereikbaar voor de tokencontrole");
  }
}

// ── TLS certificates ─────────────────────────────────────────────────────────

function tlsCertExpiry(host: string, port: number): Promise<Date> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port, servername: host, timeout: 10_000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) {
          reject(new Error("geen certificaat ontvangen"));
          return;
        }
        const date = new Date(cert.valid_to);
        if (isNaN(date.getTime())) {
          reject(new Error("certificaatdatum onleesbaar"));
          return;
        }
        resolve(date);
      },
    );
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("verbinding verliep (timeout)"));
    });
  });
}

async function tlsItems(): Promise<ExpiryItem[]> {
  const hostsEnv = process.env.EXPIRY_TLS_HOSTS;
  if (!hostsEnv) {
    return [
      unknown(
        {
          id: "tls:unconfigured",
          label: "TLS-certificaten draaiende omgevingen",
          category: "tls_certificate",
          consequence:
            "Bezoekers krijgen dan een beveiligingswaarschuwing en de omgeving is onbereikbaar.",
        },
        "geen omgevingen geconfigureerd — vul de geheime variabele EXPIRY_TLS_HOSTS met een kommagescheiden lijst hostnamen",
      ),
    ];
  }
  const hosts = hostsEnv.split(",").map((h) => h.trim()).filter(Boolean);
  return Promise.all(
    hosts.map(async (entry) => {
      const [host, portStr] = entry.split(":");
      const port = portStr ? Number(portStr) : 443;
      const base = {
        id: `tls:${entry}`,
        label: `TLS-certificaat ${host}`,
        category: "tls_certificate" as const,
        consequence:
          "Bezoekers krijgen dan een beveiligingswaarschuwing en de omgeving is onbereikbaar.",
        staleNote: null,
      };
      try {
        return known(base, await tlsCertExpiry(host ?? entry, port));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
          return redAlert(
            base,
            "Het certificaat is uitgegeven voor een andere domeinnaam — bezoekers krijgen nu al een beveiligingswaarschuwing.",
          );
        }
        return unknown(
          base,
          `certificaat kon niet worden uitgelezen (${err instanceof Error ? err.message : "onbekende fout"})`,
        );
      }
    }),
  );
}

// ── Azure client key (FPS Connect) ──────────────────────────────────────────

async function azureItem(): Promise<ExpiryItem> {
  const base = {
    id: "azure:fps-connect",
    label: "Azure-clientsleutel FPS Connect",
    category: "azure_key" as const,
    consequence:
      "FPS Connect kan dan niet meer inloggen bij Azure; de koppelingen van FPS Connect vallen uit.",
  };
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    return unknown(
      base,
      "bewust niet aangesloten — de Azure-sleutel geeft toegang tot de postbussen en wordt daarom niet in dit project bewaard; houd de einddatum in Azure zelf in de gaten",
    );
  }
  try {
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }),
      },
    );
    if (!tokenRes.ok)
      return unknown(base, `Azure weigerde de aanmelding (status ${tokenRes.status})`);
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const appRes = await fetch(
      `https://graph.microsoft.com/v1.0/applications(appId='${clientId}')?$select=passwordCredentials`,
      { headers: { Authorization: `Bearer ${access_token}` } },
    );
    if (!appRes.ok)
      return unknown(
        base,
        `Microsoft Graph weigerde het uitlezen (status ${appRes.status} — heeft de app Application.Read.All?)`,
      );
    const app = (await appRes.json()) as {
      passwordCredentials?: Array<{ endDateTime: string }>;
    };
    const dates = (app.passwordCredentials ?? [])
      .map((c) => new Date(c.endDateTime))
      .filter((d) => !isNaN(d.getTime()))
      .sort((a, b) => b.getTime() - a.getTime());
    const latest = dates[0];
    if (!latest) return unknown(base, "er is geen clientsleutel gevonden op de Azure-app");
    return known(base, latest);
  } catch (err) {
    logger.warn({ err }, "Azure-sleutelcontrole mislukt");
    return unknown(base, "Azure was niet bereikbaar voor de sleutelcontrole");
  }
}

/** Per-domain last-known expiry date, kept in memory across cache refreshes. */
interface DomainLastKnown {
  date: Date;
  fetchedAt: number; // ms timestamp
}

/**
 * Persists a successful RDAP reading to the database so the stale fallback
 * survives a server restart. Errors are silently swallowed — the in-memory
 * cache is the authoritative source; the DB is a durability bonus only.
 */
async function persistDomainExpiry(domain: string, date: Date): Promise<void> {
  try {
    const { db, domainExpiryCache } = await import("@workspace/db");
    const now = new Date();
    await db
      .insert(domainExpiryCache)
      .values({ domain, expiresAt: date, fetchedAt: now })
      .onConflictDoUpdate({
        target: domainExpiryCache.domain,
        set: { expiresAt: date, fetchedAt: now },
      });
  } catch {
    // DB unavailable or not configured — silently skip.
  }
}
async function domainExpiry(domain: string): Promise<Date | null> {
  const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
    headers: { Accept: "application/rdap+json" },
    redirect: "follow",
  });
  if (res.status === 429) {
    const retryAfterHeader = res.headers.get("Retry-After");
    const backoffMs = retryAfterHeader
      ? (Number(retryAfterHeader) * 1000 || RDAP_DEFAULT_BACKOFF_MS)
      : RDAP_DEFAULT_BACKOFF_MS;
    throw new RdapRateLimitError(backoffMs);
  }
  if (!res.ok) throw new Error(`RDAP status ${res.status}`);
  const data = (await res.json()) as {
    events?: Array<{ eventAction: string; eventDate: string }>;
  };
  const event = (data.events ?? []).find((e) => e.eventAction === "expiration");
  if (!event) return null;
  const date = new Date(event.eventDate);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Returns a known item from the last-known cache (with a stale note) when the
 * cache is fresh enough, or an unknown item otherwise.
 *
 * Falls back to the database when the in-memory cache is empty (e.g. after a
 * server restart). The DB row must still be within RDAP_STALE_MAX_MS.
 */
async function staleOrUnknown(
  base: Parameters<typeof unknown>[0],
  domain: string,
  reason: string,
): Promise<ExpiryItem> {
  const inMemory = domainLastKnown.get(domain);
  if (inMemory && Date.now() - inMemory.fetchedAt <= RDAP_STALE_MAX_MS) {
    const fetchedDate = new Date(inMemory.fetchedAt).toLocaleDateString("nl-NL");
    return known(base, inMemory.date, `op basis van meting van ${fetchedDate} — ${reason}`);
  }
  // In-memory cache is empty or too old — try the database fallback.
  const dbCached = await loadDomainExpiryFromDb(domain);
  if (dbCached && Date.now() - dbCached.fetchedAt <= RDAP_STALE_MAX_MS) {
    const fetchedDate = new Date(dbCached.fetchedAt).toLocaleDateString("nl-NL");
    // Populate in-memory cache to avoid repeated DB round-trips.
    domainLastKnown.set(domain, dbCached);
    return known(base, dbCached.date, `op basis van meting van ${fetchedDate} — ${reason}`);
  }
  return unknown(base, reason);
}
async function domainItems(): Promise<ExpiryItem[]> {
  const domainsEnv = process.env.EXPIRY_DOMAINS;
  const consequence =
    "De site en e-mail op dit domein vallen dan uit en het domein kan vrijkomen voor anderen.";
  if (!domainsEnv) {
    return [
      unknown(
        {
          id: "domain:unconfigured",
          label: "Domeinverlenging",
          category: "domain",
          consequence,
        },
        "geen domeinen geconfigureerd — vul de geheime variabele EXPIRY_DOMAINS met een kommagescheiden lijst domeinnamen",
      ),
    ];
  }
  const domains = domainsEnv.split(",").map((d) => d.trim()).filter(Boolean);
  const manual = parseManualExpiries();

  // Process domains sequentially with a small delay to avoid hammering RDAP.
  const results: ExpiryItem[] = [];
  for (let i = 0; i < domains.length; i++) {
    if (i > 0) await sleep(RDAP_REQUEST_DELAY_MS);
    const domain = domains[i];
    const base = {
      id: `domain:${domain}`,
      label: `Domein ${domain}`,
      category: "domain" as const,
      consequence,
    };

    // Manually maintained date (e.g. .nl domains: SIDN publishes no expiry
    // via RDAP). Never queried at the registry; the date comes from the
    // EXPIRY_MANUAL secret and is clearly marked as manually entered.
    const manualDate = manual.get(domain.toLowerCase());
    if (manualDate) {
      results.push(known({ ...base, label: `Domein ${domain} (handmatig ingevoerd)` }, manualDate));
      continue;
    }
    if (domain.toLowerCase().endsWith(".nl")) {
      results.push(
        unknown(
          base,
          "het .nl-register (SIDN) publiceert geen verloopdatum — zet de datum handmatig in het geheim EXPIRY_MANUAL, bijvoorbeeld: " +
            `${domain}=2027-06-14`,
        ),
      );
      continue;
    }

    // Skip if currently in back-off window (previous 429).
    const backoffUntil = rdapBackoffUntil.get(domain) ?? 0;
    if (Date.now() < backoffUntil) {
      results.push(
        await staleOrUnknown(base, domain, "het domeinregister is tijdelijk overbelast; verzoeken worden even overgeslagen"),
      );
      continue;
    }

    try {
      const date = await domainExpiry(domain);
      if (!date) {
        results.push(unknown(base, "het domeinregister publiceert geen verloopdatum voor deze extensie"));
      } else {
        domainLastKnown.set(domain, { date, fetchedAt: Date.now() });
        // Fire-and-forget: persist to DB so the stale fallback survives restarts.
        void persistDomainExpiry(domain, date);
        results.push(known(base, date));
      }
    } catch (err) {
      if (err instanceof RdapRateLimitError) {
        rdapBackoffUntil.set(domain, Date.now() + err.backoffMs);
        logger.warn({ domain, backoffMs: err.backoffMs }, "RDAP 429 — domein tijdelijk overgeslagen");
        results.push(await staleOrUnknown(base, domain, "het domeinregister vraagt om minder verzoeken (429)"));
      } else {
        logger.warn({ err, domain }, "RDAP-verzoek mislukt");
        results.push(
          await staleOrUnknown(
            base,
            domain,
            `verloopdatum kon niet worden opgevraagd (${err instanceof Error ? err.message : "onbekende fout"})`,
          ),
        );
      }
    }
  }
  return results;
}

/**
 * Parses the EXPIRY_MANUAL secret: entries `domein=JJJJ-MM-DD`, separated by
 * newlines, commas or semicolons. Invalid entries are skipped silently — an
 * unreadable manual date simply leaves the domain "unknown" with instructions.
 */
function parseManualExpiries(): Map<string, Date> {
  const raw = process.env.EXPIRY_MANUAL ?? "";
  const map = new Map<string, Date>();
  for (const entry of raw.split(/[\n,;]+/)) {
    const [domain, dateStr] = entry.split("=").map((s) => s?.trim());
    if (!domain || !dateStr) continue;
    const date = new Date(`${dateStr}T00:00:00Z`);
    if (!isNaN(date.getTime())) map.set(domain.toLowerCase(), date);
  }
  return map;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function listExpiryItems(bypassCache = false): Promise<ExpiryItem[]> {
  if (!bypassCache && cached && cached.expiresAt > Date.now()) {
    return cached.items;
  }

  const [readToken, pushToken, tlsList, azure, domains] = await Promise.all([
    githubTokenItem(
      "github:read-token",
      "GitHub-leestoken (GITHUB_TOKEN)",
      "Het beheercentrum kan dan geen status meer ophalen bij GitHub; alle codebases worden grijs.",
      process.env.GITHUB_TOKEN,
      "GITHUB_TOKEN is niet geconfigureerd",
    ),
    githubTokenItem(
      "github:push-token",
      "GitHub-pushtoken (GITHUB_PUSH_TOKEN)",
      "Replit kan dan niet meer pushen naar GitHub.",
      process.env.GITHUB_PUSH_TOKEN,
      "geen pushtoken geconfigureerd — vul de geheime variabele GITHUB_PUSH_TOKEN zodat de einddatum bewaakt kan worden",
    ),
    tlsItems(),
    azureItem(),
    domainItems(),
  ]);

  const items = [readToken, pushToken, ...tlsList, azure, ...domains];

  // Most urgent first: red, orange, unknown, ok; within a group by daysLeft.
  const order: Record<ExpirySeverity, number> = { red: 0, orange: 1, unknown: 2, ok: 3 };
  items.sort((a, b) => {
    const diff = order[a.severity] - order[b.severity];
    if (diff !== 0) return diff;
    return (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity);
  });

  cached = { items, expiresAt: Date.now() + CACHE_TTL_MS };
  return items;
}

/**
 * Per-domain 429 back-off: value is the timestamp (ms) until which RDAP
 * requests for that domain should be skipped.
 */
const rdapBackoffUntil = new Map<string, number>();

class RdapRateLimitError extends Error {
  constructor(public readonly backoffMs: number) {
    super(`RDAP rate-limited; retry after ${backoffMs / 1000}s`);
  }
}

const domainLastKnown = new Map<string, DomainLastKnown>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Default back-off when RDAP returns 429 without a Retry-After header. */
const RDAP_DEFAULT_BACKOFF_MS = 60 * 60 * 1000; // 1 hour

/** Maximum age of a cached domain date before it is considered too stale to show. */
const RDAP_STALE_MAX_MS = 7 * DAY_MS;

/** Delay between sequential RDAP requests to avoid hammering the registry. */
const RDAP_REQUEST_DELAY_MS = 500;

/**
 * Loads the most recent persisted RDAP date for a domain from the database.
 * Returns null when the DB is unavailable or no row exists.
 */
async function loadDomainExpiryFromDb(domain: string): Promise<DomainLastKnown | null> {
  try {
    const { db, domainExpiryCache } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(domainExpiryCache)
      .where(eq(domainExpiryCache.domain, domain))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { date: row.expiresAt, fetchedAt: row.fetchedAt.getTime() };
  } catch {
    return null;
  }
}
