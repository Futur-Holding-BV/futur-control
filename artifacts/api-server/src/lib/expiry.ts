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
  base: Omit<ExpiryItem, "expiresAt" | "daysLeft" | "severity" | "unknownReason">,
  expiresAt: Date,
): ExpiryItem {
  return {
    ...base,
    expiresAt: expiresAt.toISOString(),
    daysLeft: daysLeft(expiresAt),
    severity: severityFor(expiresAt),
    unknownReason: null,
  };
}

function unknown(
  base: Omit<ExpiryItem, "expiresAt" | "daysLeft" | "severity" | "unknownReason">,
  reason: string,
): ExpiryItem {
  return {
    ...base,
    expiresAt: null,
    daysLeft: null,
    severity: "unknown",
    unknownReason: reason,
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
      };
      try {
        return known(base, await tlsCertExpiry(host ?? entry, port));
      } catch (err) {
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
      "geen Azure-toegang geconfigureerd — vul AZURE_TENANT_ID, AZURE_CLIENT_ID en AZURE_CLIENT_SECRET (leesrechten Application.Read.All volstaan)",
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

// ── Domain renewals via RDAP ─────────────────────────────────────────────────

async function domainExpiry(domain: string): Promise<Date | null> {
  const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
    headers: { Accept: "application/rdap+json" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`RDAP status ${res.status}`);
  const data = (await res.json()) as {
    events?: Array<{ eventAction: string; eventDate: string }>;
  };
  const event = (data.events ?? []).find((e) => e.eventAction === "expiration");
  if (!event) return null;
  const date = new Date(event.eventDate);
  return isNaN(date.getTime()) ? null : date;
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
  return Promise.all(
    domains.map(async (domain) => {
      const base = {
        id: `domain:${domain}`,
        label: `Domein ${domain}`,
        category: "domain" as const,
        consequence,
      };
      try {
        const date = await domainExpiry(domain);
        if (!date)
          return unknown(base, "het domeinregister publiceert geen verloopdatum voor deze extensie");
        return known(base, date);
      } catch (err) {
        return unknown(
          base,
          `verloopdatum kon niet worden opgevraagd (${err instanceof Error ? err.message : "onbekende fout"})`,
        );
      }
    }),
  );
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
