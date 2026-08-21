import { pool } from "@workspace/db";
import {
  isVertrouwdeDirecteSentryMelding,
  type VeiligSentrySignaal,
} from "./sentryPolicy.js";
import { openFinding, resolveFinding } from "./findings.js";

const MINIMALE_HERHALING = 2;

interface PgClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
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
    const issue = await client.query(
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
      RETURNING aantal
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
    const aantal = Number(issue.rows[0]?.["aantal"] ?? 0);
    if (aantal >= MINIMALE_HERHALING) {
      const direct = isVertrouwdeDirecteSentryMelding(
        signaal,
        process.env["SENTRY_ROUTING_SIGNING_SECRET"],
        process.env["SENTRY_DIRECT_API_PROJECT"],
      );
      // Schrijf de centrale bevinding vóór COMMIT. Als dit faalt, rolt ook de
      // eventclaim terug en kan Sentry hetzelfde event veilig opnieuw aanbieden.
      await openFinding({
        id: `sentry:${signaal.issueKey}`,
        kind: direct ? "sentry_direct" : "sentry_error",
        subject: signaal.project,
        title: direct
          ? `Directe foutblokkade in ${signaal.project}`
          : `Actieve fout in ${signaal.project}`,
        detail: [
          `Component: ${signaal.component}`,
          signaal.handeling ? `Handeling: ${signaal.handeling}` : null,
          signaal.omgeving ? `Omgeving: ${signaal.omgeving}` : null,
          signaal.release ? `Release: ${signaal.release}` : null,
          signaal.issueUrl ? `Sentry: ${signaal.issueUrl}` : null,
          `Minimaal ${aantal} keer waargenomen.`,
        ]
          .filter((regel): regel is string => Boolean(regel))
          .join("\n"),
      });
    }
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
  await resolveFinding(`sentry:${issueKey}`);
}