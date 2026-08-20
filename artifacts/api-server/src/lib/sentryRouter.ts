import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "./logger.js";
import {
  isDagbundelMoment,
  isVertrouwdeDirecteSentryMelding,
  magDirectMelden,
  type VeiligSentrySignaal,
} from "./sentryPolicy.js";
import {
  notifySentryDagbundel,
  notifySentryDirect,
  type SentryMelding,
} from "./notifications.js";

const ROUTER_INTERVAL_MS = 60_000;
const ROUTER_LOCK_KEY = "6839201476";
const MINIMALE_HERHALING = 2;
const CLAIM_TIMEOUT_MINUTEN = 15;

interface PgClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
}

function naarMelding(rij: Record<string, unknown>): SentryMelding {
  return {
    issueKey: String(rij["issue_key"]),
    project: String(rij["project"]),
    component: String(rij["component"]),
    handeling:
      typeof rij["handeling"] === "string" ? rij["handeling"] : null,
    omgeving: typeof rij["omgeving"] === "string" ? rij["omgeving"] : null,
    release: typeof rij["release"] === "string" ? rij["release"] : null,
    issueUrl: typeof rij["issue_url"] === "string" ? rij["issue_url"] : null,
    aantal: Number(rij["aantal"]),
  };
}

export async function registreerSentrySignaal(
  signaal: VeiligSentrySignaal,
): Promise<void> {
  // Zonder stabiele Sentry-event-id kan een at-least-once retry niet veilig
  // van een nieuw voorkomen worden onderscheiden; dan tellen we fail-closed
  // niet op.
  if (!signaal.eventKey) return;
  const client = (await pool.connect()) as unknown as PgClient;
  try {
    await client.query("BEGIN");
    const claim = await client.query(
      `
        INSERT INTO sentry_router_events (event_key, issue_key)
        VALUES ($1, $2)
        ON CONFLICT (event_key) DO NOTHING
        RETURNING event_key
      `,
      [signaal.eventKey, signaal.issueKey],
    );
    if (claim.rowCount !== 1) {
      await client.query("ROLLBACK");
      return;
    }
    await client.query(
      `
      INSERT INTO sentry_router_issues (
        issue_key, project, component, handeling, omgeving, release,
        verwijzingscode, routing_bewijs, issue_url
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (issue_key) DO UPDATE SET
        project = EXCLUDED.project,
        component = EXCLUDED.component,
        handeling = EXCLUDED.handeling,
        omgeving = EXCLUDED.omgeving,
        release = EXCLUDED.release,
        verwijzingscode = EXCLUDED.verwijzingscode,
        routing_bewijs = EXCLUDED.routing_bewijs,
        issue_url = EXCLUDED.issue_url,
        aantal = CASE
          WHEN sentry_router_issues.opgelost_op IS NULL
            THEN sentry_router_issues.aantal + 1
          ELSE 1
        END,
        eerste_gezien_op = CASE
          WHEN sentry_router_issues.opgelost_op IS NULL
            THEN sentry_router_issues.eerste_gezien_op
          ELSE NOW()
        END,
        laatste_gezien_op = NOW(),
        opgelost_op = NULL,
        gemeld_op = CASE
          WHEN sentry_router_issues.opgelost_op IS NULL
            THEN sentry_router_issues.gemeld_op
          ELSE NULL
        END
      `,
      [
        signaal.issueKey,
        signaal.project,
        signaal.component,
        signaal.handeling,
        signaal.omgeving,
        signaal.release,
        signaal.verwijzingscode,
        signaal.routingBewijs,
        signaal.issueUrl,
      ],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function markeerSentryIssueOpgelost(
  issueKey: string,
): Promise<void> {
  await pool.query(
    `
      UPDATE sentry_router_issues
      SET opgelost_op = NOW(),
          meld_claim_token = NULL,
          meld_claim_op = NULL
      WHERE issue_key = $1 AND opgelost_op IS NULL
    `,
    [issueKey],
  );
}

async function laadOngemeldeIssues(client: PgClient): Promise<{
  direct: SentryMelding[];
  dagbundel: SentryMelding[];
}> {
  const resultaat = await client.query(
    `
      SELECT issue_key, project, component, handeling, omgeving, release,
             verwijzingscode, routing_bewijs, issue_url, aantal
      FROM sentry_router_issues
      WHERE opgelost_op IS NULL
        AND gemeld_op IS NULL
        AND aantal >= $1
        AND (
          meld_claim_op IS NULL
          OR meld_claim_op < NOW() - ($2::text || ' minutes')::interval
        )
      ORDER BY laatste_gezien_op ASC
    `,
    [MINIMALE_HERHALING, CLAIM_TIMEOUT_MINUTEN],
  );
  const direct: SentryMelding[] = [];
  const dagbundel: SentryMelding[] = [];
  for (const rij of resultaat.rows) {
    const melding = naarMelding(rij);
    if (isVertrouwdeDirecteRij(rij)) {
      direct.push(melding);
    } else {
      dagbundel.push(melding);
    }
  }
  return { direct, dagbundel };
}

function isVertrouwdeDirecteRij(rij: Record<string, unknown>): boolean {
  const melding = naarMelding(rij);
  return isVertrouwdeDirecteSentryMelding(
    {
      project: melding.project,
      component: melding.component,
      handeling: melding.handeling,
      omgeving: melding.omgeving,
      verwijzingscode:
        typeof rij["verwijzingscode"] === "string"
          ? rij["verwijzingscode"]
          : null,
      routingBewijs:
        typeof rij["routing_bewijs"] === "string"
          ? rij["routing_bewijs"]
          : null,
    },
    process.env["SENTRY_ROUTING_SIGNING_SECRET"],
    process.env["SENTRY_DIRECT_API_PROJECT"],
  );
}

async function claimSentryMelding(
  client: PgClient,
  issueKey: string,
  claimToken: string,
): Promise<Record<string, unknown> | null> {
  const resultaat = await client.query(
    `
      UPDATE sentry_router_issues
      SET meld_claim_token = $2,
          meld_claim_op = NOW()
      WHERE issue_key = $1
        AND opgelost_op IS NULL
        AND gemeld_op IS NULL
        AND aantal >= $3
        AND (
          meld_claim_op IS NULL
          OR meld_claim_op < NOW() - ($4::text || ' minutes')::interval
        )
      RETURNING issue_key, project, component, handeling, omgeving, release,
                verwijzingscode, routing_bewijs, issue_url, aantal
    `,
    [issueKey, claimToken, MINIMALE_HERHALING, CLAIM_TIMEOUT_MINUTEN],
  );
  return resultaat.rowCount === 1 ? (resultaat.rows[0] ?? null) : null;
}

async function markeerGemeld(
  client: PgClient,
  meldingen: SentryMelding[],
  claimToken: string,
): Promise<void> {
  if (meldingen.length === 0) return;
  await client.query(
    `
      UPDATE sentry_router_issues
      SET gemeld_op = NOW(),
          meld_claim_token = NULL,
          meld_claim_op = NULL
      WHERE issue_key = ANY($1::text[])
        AND opgelost_op IS NULL
        AND gemeld_op IS NULL
        AND meld_claim_token = $2
    `,
    [meldingen.map((melding) => melding.issueKey), claimToken],
  );
}

async function geefClaimsVrij(
  client: PgClient,
  meldingen: SentryMelding[],
  claimToken: string,
): Promise<void> {
  if (meldingen.length === 0) return;
  await client.query(
    `
      UPDATE sentry_router_issues
      SET meld_claim_token = NULL,
          meld_claim_op = NULL
      WHERE issue_key = ANY($1::text[])
        AND meld_claim_token = $2
    `,
    [meldingen.map((melding) => melding.issueKey), claimToken],
  );
}

export async function verwerkSentryMeldingen(
  nu = new Date(),
): Promise<void> {
  const directToegestaan = magDirectMelden(nu);
  const dagbundelToegestaan = isDagbundelMoment(nu);
  if (!directToegestaan && !dagbundelToegestaan) return;

  const client = (await pool.connect()) as unknown as PgClient;
  let lock = false;
  try {
    const lockResultaat = await client.query(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [ROUTER_LOCK_KEY],
    );
    lock = Boolean(lockResultaat.rows[0]?.["acquired"]);
    if (!lock) return;

    const meldingen = await laadOngemeldeIssues(client);

    if (directToegestaan) {
      for (const melding of meldingen.direct) {
        const claimToken = randomUUID();
        const geclaimdeRij = await claimSentryMelding(
          client,
          melding.issueKey,
          claimToken,
        );
        if (!geclaimdeRij) continue;
        const geclaimd = naarMelding(geclaimdeRij);
        if (!isVertrouwdeDirecteRij(geclaimdeRij)) {
          await geefClaimsVrij(client, [geclaimd], claimToken);
          continue;
        }
        if (await notifySentryDirect(geclaimd)) {
          await markeerGemeld(client, [geclaimd], claimToken);
        } else {
          await geefClaimsVrij(client, [geclaimd], claimToken);
        }
      }
    }
    if (
      dagbundelToegestaan &&
      meldingen.dagbundel.length > 0
    ) {
      const claimToken = randomUUID();
      const actief: SentryMelding[] = [];
      for (const melding of meldingen.dagbundel) {
        const geclaimdeRij = await claimSentryMelding(
          client,
          melding.issueKey,
          claimToken,
        );
        if (!geclaimdeRij) continue;
        const geclaimd = naarMelding(geclaimdeRij);
        if (isVertrouwdeDirecteRij(geclaimdeRij)) {
          await geefClaimsVrij(client, [geclaimd], claimToken);
          continue;
        }
        actief.push(geclaimd);
      }
      if (actief.length > 0 && (await notifySentryDagbundel(actief))) {
        await markeerGemeld(client, actief, claimToken);
      } else {
        await geefClaimsVrij(client, actief, claimToken);
      }
    }
    await client.query(
      "DELETE FROM sentry_router_events WHERE ontvangen_op < NOW() - INTERVAL '90 days'",
    );
  } catch (err) {
    logger.error({ err }, "Sentry-meldroutering mislukt");
  } finally {
    if (lock) {
      await client
        .query("SELECT pg_advisory_unlock($1::bigint)", [ROUTER_LOCK_KEY])
        .catch(() => undefined);
    }
    client.release();
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startSentryRouter(): void {
  if (timer) return;
  void verwerkSentryMeldingen();
  timer = setInterval(() => void verwerkSentryMeldingen(), ROUTER_INTERVAL_MS);
  timer.unref();
  logger.info(
    { intervalMs: ROUTER_INTERVAL_MS },
    "Sentry-meldroutering gestart",
  );
}