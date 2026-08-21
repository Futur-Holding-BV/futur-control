/**
 * FPS-Connect operationele bewaking (BEWAKING_01).
 *
 * Bevraagt het publieke GET-eindpunt van FPS-Connect en levert vijf
 * gestandaardiseerde controleresultaten voor het dagrapport:
 *   1. connect:production   — bereikbaar + versie bekend + commit overeenkomst
 *   2. connect:build        — bouwstatus (rood/grijs > 24 u → fout)
 *   3. connect:db-backup    — databaseback-up < 24 u
 *   4. connect:nas-pull     — NAS-synchronisatie < 36 u
 *   5. connect:mail         — uitgaande mail < 24 u
 *
 * Security: URL-querydetails, antwoordtekst, tokens, paden of andere
 * gevoelige gegevens worden nooit gelogd of in bevindingen opgenomen.
 */

import { pool } from "@workspace/db";
import { openFinding, resolveFinding } from "./findings.js";
import { getDefaultBranchCommitSha } from "./github.js";
import { logger } from "./logger.js";
import {
  unknownConnectChecks,
  type ConnectCheck,
} from "./connectCheckModel.js";

export { unknownConnectChecks } from "./connectCheckModel.js";
export type { ConnectCheck } from "./connectCheckModel.js";

// ─── Publieke types ──────────────────────────────────────────────────────────

// ─── Interne types ───────────────────────────────────────────────────────────

type MeasurementStatus = "ok" | "unknown" | "error";

interface Measurement {
  status: MeasurementStatus;
  last_success_at: string | null;
}

interface ConnectResponse {
  version: string;
  commit: string | null;
  measured_at: string;
  database_backup: Measurement;
  nas_pull: Measurement;
  outgoing_mail: Measurement;
}

// ─── Constanten ──────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 10_000;
const MONITOR_STATE_KEY = "connect:status:checks";

// Maximale leeftijd in milliseconden voor elke meting.
const MAX_AGE_DB_BACKUP_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_NAS_PULL_MS = 36 * 60 * 60 * 1000;
const MAX_AGE_MAIL_MS = 24 * 60 * 60 * 1000;

// ─── URL-validatie ───────────────────────────────────────────────────────────

/**
 * Valideert de CONNECT_STATUS_URL omgevingsvariabele.
 * In productie is alleen HTTPS toegestaan; in andere omgevingen mag
 * ook http://localhost of http://127.0.0.1 worden gebruikt.
 *
 * Geeft de URL terug of gooit een Error bij een ongeldige waarde.
 */
export function resolveConnectStatusUrl(): string {
  const raw = process.env.CONNECT_STATUS_URL;
  if (!raw) {
    throw new Error("CONNECT_STATUS_URL is niet geconfigureerd");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("CONNECT_STATUS_URL is geen geldige URL");
  }

  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction) {
    if (parsed.protocol !== "https:") {
      throw new Error("CONNECT_STATUS_URL vereist HTTPS in productie");
    }
  } else {
    if (parsed.protocol === "https:") {
      // HTTPS is altijd toegestaan.
    } else if (parsed.protocol === "http:") {
      const hostname = parsed.hostname;
      if (hostname !== "localhost" && hostname !== "127.0.0.1") {
        throw new Error(
          "CONNECT_STATUS_URL: HTTP is alleen toegestaan voor localhost of 127.0.0.1",
        );
      }
    } else {
      throw new Error("CONNECT_STATUS_URL: alleen HTTP of HTTPS zijn toegestaan");
    }
  }

  return raw;
}

// ─── Responsvalidatie ────────────────────────────────────────────────────────

function isMeasurementStatus(value: unknown): value is MeasurementStatus {
  return value === "ok" || value === "unknown" || value === "error";
}

function isMeasurement(value: unknown): value is Measurement {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!isMeasurementStatus(obj["status"])) return false;
  if (obj["last_success_at"] !== null && typeof obj["last_success_at"] !== "string") return false;
  return true;
}

function validateConnectResponse(raw: unknown): ConnectResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  if (
    typeof obj["version"] !== "string"
    || !/^[a-zA-Z0-9._+-]{1,80}$/.test(obj["version"])
  ) {
    return null;
  }
  if (
    obj["commit"] !== null
    && (
      typeof obj["commit"] !== "string"
      || !/^[0-9a-f]{7,64}$/i.test(obj["commit"])
    )
  ) {
    return null;
  }
  if (typeof obj["measured_at"] !== "string" || !obj["measured_at"]) return null;

  if (!isMeasurement(obj["database_backup"])) return null;
  if (!isMeasurement(obj["nas_pull"])) return null;
  if (!isMeasurement(obj["outgoing_mail"])) return null;

  return {
    version: obj["version"] as string,
    commit: obj["commit"] as string,
    measured_at: obj["measured_at"] as string,
    database_backup: obj["database_backup"] as Measurement,
    nas_pull: obj["nas_pull"] as Measurement,
    outgoing_mail: obj["outgoing_mail"] as Measurement,
  };
}

// ─── Ophalen van Connect-status ──────────────────────────────────────────────

/**
 * Haalt de Connect-status op. Geeft null terug bij een netwerk- of
 * parseerfout — een veilige fallouttoestand.
 * De antwoordtekst en URL-querydetails worden nooit gelogd.
 */
async function fetchConnectStatus(): Promise<ConnectResponse | null> {
  let url: string;
  try {
    url = resolveConnectStatusUrl();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Connect: URL-configuratie ongeldig");
    return null;
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn(
        { status: response.status },
        "Connect: eindpunt gaf een niet-succesvolle status",
      );
      return null;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      logger.warn("Connect: antwoord is geen geldige JSON");
      return null;
    }
    const validated = validateConnectResponse(body);
    if (!validated) {
      logger.warn("Connect: antwoord voldoet niet aan het verwachte contract");
      return null;
    }
    return validated;
  } catch (err) {
    const code = (err as { code?: string }).code ?? (err as Error).name ?? "onbekend";
    logger.warn({ code }, "Connect: ophalen van status mislukt");
    return null;
  }
}

// ─── Hulpfuncties ────────────────────────────────────────────────────────────

/**
 * Bepaalt of een timestamp geldig is en recent genoeg.
 * Toekomstige timestamps en ongeldige timestamps geven false.
 */
function isWithinAge(timestamp: string | null, maxAgeMs: number, now: Date): boolean {
  if (!timestamp) return false;
  const ts = new Date(timestamp).getTime();
  if (!Number.isFinite(ts)) return false;
  const nowMs = now.getTime();
  // Toekomstige timestamps zijn ongeldig.
  if (ts > nowMs) return false;
  return nowMs - ts <= maxAgeMs;
}

/**
 * Vertaalt een meting naar een check-status voor versheid-controles.
 * status "ok" met recente timestamp → ok
 * status "ok" met oude/ontbrekende timestamp → warning
 * status "unknown" → unknown
 * status "error" of ontbrekende timestamp bij "ok" → error/warning
 */
function measurementCheck(
  measurement: Measurement,
  maxAgeMs: number,
  now: Date,
): { status: ConnectCheck["status"]; freshnessOk: boolean } {
  if (measurement.status === "unknown") {
    return { status: "unknown", freshnessOk: false };
  }
  if (measurement.status === "error") {
    return { status: "error", freshnessOk: false };
  }
  // status === "ok"
  const fresh = isWithinAge(measurement.last_success_at, maxAgeMs, now);
  return { status: fresh ? "ok" : "warning", freshnessOk: fresh };
}

// ─── De vijf controleresultaten ──────────────────────────────────────────────

/**
 * Controle 1: Connect productie.
 * Groepeert: bereikbaar, versie bekend, commit overeenkomst met GitHub main.
 */
async function buildProductionCheck(
  data: ConnectResponse | null,
  githubCommit: string | null,
): Promise<ConnectCheck> {
  const id = "connect:production";
  const label = "Connect productie";

  if (!data) {
    return {
      id,
      label,
      status: "error",
      detail: "FPS-Connect is niet bereikbaar of geeft een ongeldig antwoord.",
    };
  }

  const versionKnown = !/^(?:onbekend|unknown|dev-onbekend)$/i.test(
    data.version,
  );
  if (!versionKnown) {
    return {
      id,
      label,
      status: "warning",
      detail: "FPS-Connect is bereikbaar, maar de versie is onbekend.",
    };
  }

  if (!githubCommit) {
    return {
      id,
      label,
      status: "warning",
      detail: "FPS-Connect is bereikbaar en versie is bekend, maar de GitHub-hoofdcommit kon niet worden opgehaald.",
    };
  }

  if (!data.commit) {
    return {
      id,
      label,
      status: "warning",
      detail: "FPS-Connect is bereikbaar, maar de actieve commit is onbekend.",
    };
  }
  const commitMatches =
    data.commit === githubCommit
    || data.commit.startsWith(githubCommit)
    || githubCommit.startsWith(data.commit);
  if (!commitMatches) {
    return {
      id,
      label,
      status: "warning",
      detail: "FPS-Connect draait niet op de laatste commit van de hoofdbranch.",
    };
  }

  return {
    id,
    label,
    status: "ok",
    detail: `FPS-Connect is bereikbaar, versie ${data.version} en op de hoofdcommit.`,
  };
}

/**
 * Controle 2: Bouwcontrole.
 * Input: huidige repostatus en hoe lang het probleem al aanhoudt.
 * Alleen een harde fout na > 24 uur rood of grijs.
 */
export function buildControlCheck(
  repoStatus: string | null,
  problemSinceMs: number | null,
  now: Date,
): ConnectCheck {
  const id = "connect:build";
  const label = "Connect bouwcontrole";

  const isProblem = repoStatus === "red" || repoStatus === "gray";

  if (!isProblem) {
    return {
      id,
      label,
      status: repoStatus === "green" ? "ok" : "unknown",
      detail:
        repoStatus === "green"
          ? "De bouwcontrole slaagt."
          : repoStatus === "yellow"
            ? "De bouwcontrole slaagt, maar de repository is mogelijk verouderd."
            : "De bouwstatus is onbekend.",
    };
  }

  // Probleem: rood of grijs
  const overThreshold =
    problemSinceMs !== null &&
    Number.isFinite(problemSinceMs) &&
    now.getTime() - problemSinceMs > 24 * 60 * 60 * 1000;

  if (overThreshold) {
    return {
      id,
      label,
      status: "error",
      detail:
        repoStatus === "red"
          ? "De bouwcontrole faalt al meer dan 24 uur."
          : "De bouwstatus is al meer dan 24 uur onbekend (grijs).",
    };
  }

  return {
    id,
    label,
    status: "warning",
    detail:
      repoStatus === "red"
        ? "De bouwcontrole faalt, maar de drempel van 24 uur is nog niet bereikt."
        : "De bouwstatus is onbekend (grijs), maar de drempel van 24 uur is nog niet bereikt.",
  };
}

/**
 * Controle 3: Databaseback-up (< 24 uur).
 */
function buildDbBackupCheck(data: ConnectResponse | null, now: Date): ConnectCheck {
  const id = "connect:db-backup";
  const label = "Connect databaseback-up";

  if (!data) {
    return {
      id,
      label,
      status: "unknown",
      detail: "FPS-Connect is niet bereikbaar; back-upstatus onbekend.",
    };
  }

  const { status, freshnessOk } = measurementCheck(
    data.database_backup,
    MAX_AGE_DB_BACKUP_MS,
    now,
  );

  return {
    id,
    label,
    status,
    detail:
      status === "ok"
        ? "De databaseback-up is recent (minder dan 24 uur geleden)."
        : status === "warning"
          ? "De databaseback-up is ouder dan 24 uur of de timestamp ontbreekt."
          : status === "error"
            ? "De databaseback-up heeft een fout gemeld."
            : "De status van de databaseback-up is onbekend.",
  };
}

/**
 * Controle 4: NAS-synchronisatie (< 36 uur).
 */
function buildNasPullCheck(data: ConnectResponse | null, now: Date): ConnectCheck {
  const id = "connect:nas-pull";
  const label = "Connect NAS-synchronisatie";

  if (!data) {
    return {
      id,
      label,
      status: "unknown",
      detail: "FPS-Connect is niet bereikbaar; NAS-status onbekend.",
    };
  }

  const { status } = measurementCheck(data.nas_pull, MAX_AGE_NAS_PULL_MS, now);

  return {
    id,
    label,
    status,
    detail:
      status === "ok"
        ? "De NAS-synchronisatie is recent (minder dan 36 uur geleden)."
        : status === "warning"
          ? "De NAS-synchronisatie is ouder dan 36 uur of de timestamp ontbreekt."
          : status === "error"
            ? "De NAS-synchronisatie heeft een fout gemeld."
            : "De status van de NAS-synchronisatie is onbekend.",
  };
}

/**
 * Controle 5: Uitgaande mail (< 24 uur).
 */
function buildMailCheck(data: ConnectResponse | null, now: Date): ConnectCheck {
  const id = "connect:mail";
  const label = "Connect uitgaande mail";

  if (!data) {
    return {
      id,
      label,
      status: "unknown",
      detail: "FPS-Connect is niet bereikbaar; mailstatus onbekend.",
    };
  }

  const { status } = measurementCheck(data.outgoing_mail, MAX_AGE_MAIL_MS, now);

  return {
    id,
    label,
    status,
    detail:
      status === "ok"
        ? "De uitgaande mail functioneert (minder dan 24 uur geleden)."
        : status === "warning"
          ? "De uitgaande mail is ouder dan 24 uur of de timestamp ontbreekt."
          : status === "error"
            ? "De uitgaande mail heeft een fout gemeld."
            : "De status van de uitgaande mail is onbekend.",
  };
}

// ─── Publieke API ─────────────────────────────────────────────────────────────

export interface BuildControlInput {
  /** Huidige GitHub-bouwstatus van de Connect-repo: "green" | "yellow" | "red" | "gray" | null */
  repoStatus: string | null;
  /** Tijdstip (ms) waarop het probleem begon; null als er geen probleem is. */
  problemSinceMs: number | null;
}

/**
 * Bouwt de vijf ConnectCheck-resultaten op basis van de live Connect-status
 * en de bouwcontrole-invoer.
 *
 * Alle externe calls (Connect-eindpunt, GitHub) falen veilig: het resultaat
 * is altijd precies vijf checks.
 */
export async function getConnectChecks(
  buildInput: BuildControlInput,
  now = new Date(),
): Promise<[ConnectCheck, ConnectCheck, ConnectCheck, ConnectCheck, ConnectCheck]> {
  const [data, githubCommit] = await Promise.all([
    fetchConnectStatus(),
    (async (): Promise<string | null> => {
      const repo = process.env.CONNECT_GITHUB_REPO?.trim() || "FPS-Connect";
      try {
        return await getDefaultBranchCommitSha(repo);
      } catch (err) {
        logger.warn(
          { code: (err as Error).message?.slice(0, 80) },
          "Connect: GitHub-commit ophalen mislukt",
        );
        return null;
      }
    })(),
  ]);

  const productionCheck = await buildProductionCheck(data, githubCommit);
  const controlCheck = buildControlCheck(buildInput.repoStatus, buildInput.problemSinceMs, now);
  const dbBackupCheck = buildDbBackupCheck(data, now);
  const nasPullCheck = buildNasPullCheck(data, now);
  const mailCheck = buildMailCheck(data, now);

  return [productionCheck, controlCheck, dbBackupCheck, nasPullCheck, mailCheck];
}

// ─── Bevindingen synchronisatie ───────────────────────────────────────────────

/**
 * Opent aanhoudende bevindingen voor ongezonde situaties en sluit ze
 * automatisch wanneer alles weer in orde is. Slaat ook de vijf checks op
 * in monitor_state voor het dagrapport.
 *
 * Gebruikt geen notificaties rechtstreeks; de findings-laag regelt dat.
 */
export async function syncConnectFindings(
  buildInput: BuildControlInput,
  now = new Date(),
): Promise<void> {
  const checks = await getConnectChecks(buildInput, now);

  // ── Bevindingen voor de productiecheck ────────────────────────────────────
  // De productiecheck wordt uitgesplitst in drie losse bevindingen zodat de
  // operateur exact weet wat er mis is.
  const productionCheck = checks[0];

  if (productionCheck.status === "error") {
    // Niet bereikbaar
    await openFinding({
      id: "connect:unreachable",
      kind: "connect_status_unavailable",
      subject: "fps-connect",
      title: "FPS-Connect is niet bereikbaar",
      detail: "Het statuseindpunt van FPS-Connect reageert niet of geeft een ongeldig antwoord.",
    });
  } else if (productionCheck.status === "warning") {
    await resolveFinding("connect:unreachable");
    if (productionCheck.detail.includes("versie is onbekend")) {
      await openFinding({
        id: "connect:version-unknown",
        kind: "deployment_mismatch",
        subject: "fps-connect",
        title: "FPS-Connect versie onbekend",
        detail: "FPS-Connect is bereikbaar, maar de versiegegevens ontbreken in het antwoord.",
      });
    } else if (productionCheck.detail.includes("laatste commit")) {
      await resolveFinding("connect:version-unknown");
      await openFinding({
        id: "connect:commit-mismatch",
        kind: "monitor_unhealthy",
        subject: "fps-connect",
        title: "FPS-Connect draait niet op de hoofdcommit",
        detail: "De actieve commit van FPS-Connect wijkt af van de hoofdbranch op GitHub.",
      });
    } else {
      await resolveFinding("connect:version-unknown");
      await openFinding({
        id: "connect:commit-mismatch",
        kind: "deployment_mismatch",
        subject: "fps-connect",
        title: "FPS-Connect hoofdcommit niet bevestigd",
        detail: "De actieve productiecommit kon niet betrouwbaar met de hoofdbranch op GitHub worden vergeleken.",
      });
    }
  } else {
    await resolveFinding("connect:unreachable");
    await resolveFinding("connect:version-unknown");
    await resolveFinding("connect:commit-mismatch");
  }

  // ── Bouwcontrole ─────────────────────────────────────────────────────────
  const buildCheck = checks[1];
  if (buildCheck.status === "error") {
    await openFinding({
      id: "connect:build",
      kind: "build_failed",
      subject: "fps-connect",
      title: "FPS-Connect bouwcontrole faalt al meer dan 24 uur",
      detail: buildCheck.detail,
    });
  } else if (buildCheck.status === "ok") {
    await resolveFinding("connect:build");
  }

  // ── Databaseback-up ───────────────────────────────────────────────────────
  const dbCheck = checks[2];
  if (dbCheck.status === "error" || dbCheck.status === "warning") {
    await openFinding({
      id: "connect:db-backup",
      kind: "backup_stale",
      subject: "fps-connect",
      title: "FPS-Connect databaseback-up niet recent",
      detail: dbCheck.detail,
    });
  } else if (dbCheck.status === "ok") {
    await resolveFinding("connect:db-backup");
  }

  // ── NAS-synchronisatie ────────────────────────────────────────────────────
  const nasCheck = checks[3];
  if (nasCheck.status === "error" || nasCheck.status === "warning") {
    await openFinding({
      id: "connect:nas-pull",
      kind: "nas_stale",
      subject: "fps-connect",
      title: "FPS-Connect NAS-synchronisatie niet recent",
      detail: nasCheck.detail,
    });
  } else if (nasCheck.status === "ok") {
    await resolveFinding("connect:nas-pull");
  }

  // ── Uitgaande mail ────────────────────────────────────────────────────────
  const mailCheck = checks[4];
  if (mailCheck.status === "error" || mailCheck.status === "warning") {
    await openFinding({
      id: "connect:mail",
      kind: "mail_inactive",
      subject: "fps-connect",
      title: "FPS-Connect uitgaande mail niet recent",
      detail: mailCheck.detail,
    });
  } else if (mailCheck.status === "ok") {
    await resolveFinding("connect:mail");
  }

  // ── Opslaan in monitor_state ──────────────────────────────────────────────
  // Sla de gesanitiseerde checks op voor het dagrapport; geen gevoelige
  // details (geen URL, geen tokens, geen antwoordtekst).
  const sanitized = checks.map(({ id, label, status, detail }) => ({
    id,
    label,
    status,
    detail,
  }));

  try {
    await pool.query(
      `INSERT INTO monitor_state (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [MONITOR_STATE_KEY, JSON.stringify(sanitized)],
    );
  } catch (err) {
    logger.error({ err: (err as Error).message }, "Connect: opslaan van status in monitor_state mislukt");
  }
}
