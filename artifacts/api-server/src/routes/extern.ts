/**
 * Extern leesadres: andere systemen kunnen hier de stand opvragen.
 *
 * GET /extern/status — samenvatting van openstaande storingen. Auth via
 *   header X-Lees-Sleutel. Alleen lezen; per sleutel maximaal 60 aanvragen
 *   per minuut; elke aanvraag komt met de sleutelnaam in het logboek.
 *
 * Sleutelbeheer (achter de beheerderslogin, meerdere sleutels naast elkaar,
 * één per aangesloten systeem — intrekken raakt de rest niet):
 *   GET    /extern/sleutels          — lijst (naam + aanmaakdatum, nooit de sleutel)
 *   POST   /extern/sleutels          — nieuwe sleutel; waarde wordt éénmalig getoond
 *   DELETE /extern/sleutels/:naam    — intrekken
 *   GET    /extern/leessleutel       — (compat) sleutel 'status-lees' opvragen/aanmaken
 *
 * De statusroute staat in de OpenAPI-spec bewust niet: dat is een extern
 * contract. Het sleutelbeheer staat er wél in (eigen frontend gebruikt het).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { timingSafeEqual, randomBytes, createHash } from "node:crypto";
import { db, apiKeys, repoStatusSnapshots } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { logAction } from "../lib/actionlog.js";

const COMPAT_KEY_NAME = "status-lees";
const MAX_REQUESTS_PER_MINUTE = 60;

function safeEqual(a: string, b: string): boolean {
  // Vergelijk vaste sha256-digests zodat er geen lengte-afhankelijk pad is.
  const ah = createHash("sha256").update(a).digest();
  const bh = createHash("sha256").update(b).digest();
  return timingSafeEqual(ah, bh);
}

/** Zoekt de sleutelnaam bij een aangeleverde sleutelwaarde (of null). */
async function findKeyName(supplied: string): Promise<string | null> {
  if (supplied.length === 0 || supplied.length > 512) return null;
  const rows = await db.select().from(apiKeys);
  let match: string | null = null;
  // Alle rijen langslopen (geen vroege exit) houdt de vergelijking tijdveilig.
  for (const row of rows) {
    if (safeEqual(supplied, row.key)) match = row.name;
  }
  return match;
}

// ── Aanvraaglimiet: vast venster van één minuut per sleutel ─────────────────

const windows = new Map<string, { start: number; count: number }>();

export function isRateLimited(
  keyName: string,
  now: number = Date.now(),
): boolean {
  // Opruimen van verlopen vensters zodat de map niet blijft groeien.
  // (De teller is bewust per proces: de server draait als één instantie.)
  if (windows.size > 50) {
    for (const [name, win] of windows) {
      if (now - win.start >= 120_000) windows.delete(name);
    }
  }
  const w = windows.get(keyName);
  if (!w || now - w.start >= 60_000) {
    windows.set(keyName, { start: now, count: 1 });
    return false;
  }
  w.count += 1;
  return w.count > MAX_REQUESTS_PER_MINUTE;
}

/** Alleen voor tests. */
export function resetRateLimiter(): void {
  windows.clear();
}

// ── Publieke basis-URL voor rechtstreekse adressen ──────────────────────────

function publicBase(req: Request): string {
  const domains = process.env["REPLIT_DOMAINS"] ?? "";
  const first = domains.split(",")[0]?.trim();
  if (first) return `https://${first}`;
  // Terugval zodat het adres altijd absoluut is, ook zonder REPLIT_DOMAINS.
  const host = req.get("host") ?? "localhost";
  return `https://${host}`;
}

function omschrijving(status: string): string {
  return status === "gray"
    ? "Geen werkende controle — status onbekend"
    : "Controle faalt of code sterk verouderd";
}

// ── Publieke router (eigen sleutelcontrole, geen sessie) ────────────────────

export const externPublicRouter: IRouter = Router();

externPublicRouter.get(
  "/extern/status",
  async (req: Request, res: Response) => {
    try {
      const keyName = await findKeyName(req.get("X-Lees-Sleutel") ?? "");
      if (keyName === null) {
        // Weigering zonder gegevens; geen logboekvervuiling door onbekenden.
        res.status(401).json({ error: "Ongeldige leessleutel." });
        return;
      }

      if (isRateLimited(keyName)) {
        // Bewust awaiten: de logboekregel hoort bij de aanvraag.
        // (logAction vangt zijn eigen fouten en gooit nooit.)
        await logAction({
          kind: "extern_lezen",
          action: "Externe statusaanvraag",
          reason: `sleutel: ${keyName}`,
          outcome: "geweigerd — meer dan 60 aanvragen per minuut",
        });
        res
          .status(429)
          .json({ error: "Te veel aanvragen — maximaal 60 per minuut." });
        return;
      }

      await logAction({
        kind: "extern_lezen",
        action: "Externe statusaanvraag",
        reason: `sleutel: ${keyName}`,
        outcome: "gelezen",
      });

      const base = publicBase(req);
      const snapshots = await db.select().from(repoStatusSnapshots);
      const storingen = snapshots
        .filter((s) => s.status === "red" || s.status === "gray")
        .map((s) => {
          const pad = `/repo/${encodeURIComponent(s.repoName)}`;
          return {
            naam: s.repoName,
            omschrijving: omschrijving(s.status),
            status: s.status,
            tijdstip: s.problemSince ? s.problemSince.toISOString() : null,
            sinds: s.problemSince ? s.problemSince.toISOString() : null,
            pad,
            adres: `${base}${pad}`,
          };
        });
      const aandacht = snapshots.filter((s) => s.status === "yellow").length;
      const zwaarste =
        storingen.length > 0 ? "rood" : aandacht > 0 ? "aandacht" : "rustig";

      res.json({
        zwaarste,
        aantalStoringen: storingen.length,
        aantalAandacht: aandacht,
        doel: storingen.length === 1 ? storingen[0]!.pad : "/",
        storingen,
        tijdstip: new Date().toISOString(),
      });
    } catch (err) {
      logger.error({ err }, "Externe statuskoppeling: opvragen mislukt");
      res.status(500).json({ error: "Status kon niet worden bepaald." });
    }
  },
);

// ── Beveiligde router (achter requireAuth gemonteerd) ───────────────────────

export const externAdminRouter: IRouter = Router();

externAdminRouter.get(
  "/extern/sleutels",
  async (_req: Request, res: Response) => {
    try {
      const rows = await db.select().from(apiKeys);
      res.json({
        sleutels: rows
          .map((r) => ({
            naam: r.name,
            aangemaakt: r.createdAt.toISOString(),
          }))
          .sort((a, b) => a.naam.localeCompare(b.naam)),
      });
    } catch (err) {
      logger.error({ err }, "Leessleutels opsommen mislukt");
      res.status(500).json({ error: "Sleutels konden niet worden opgehaald." });
    }
  },
);

externAdminRouter.post(
  "/extern/sleutels",
  async (req: Request, res: Response) => {
    try {
      const naam = String((req.body as { naam?: unknown })?.naam ?? "").trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{1,63}$/.test(naam)) {
        res.status(400).json({
          error:
            "Geef een naam van 2–64 tekens (letters, cijfers, spaties, - _ .).",
        });
        return;
      }
      const sleutel = randomBytes(32).toString("base64url");
      const inserted = await db
        .insert(apiKeys)
        .values({ name: naam, key: sleutel })
        .onConflictDoNothing()
        .returning({ name: apiKeys.name });
      if (inserted.length === 0) {
        res
          .status(409)
          .json({ error: "Er bestaat al een sleutel met deze naam." });
        return;
      }
      void logAction({
        kind: "extern_lezen",
        action: "Leessleutel aangemaakt",
        reason: `sleutel: ${naam}`,
        outcome: "aangemaakt",
      });
      // De sleutelwaarde wordt éénmalig teruggegeven en daarna nooit meer.
      res.status(201).json({ naam, sleutel });
    } catch (err) {
      logger.error({ err }, "Leessleutel aanmaken mislukt");
      res.status(500).json({ error: "Sleutel kon niet worden aangemaakt." });
    }
  },
);

externAdminRouter.delete(
  "/extern/sleutels/:naam",
  async (req: Request, res: Response) => {
    try {
      const naam = String(req.params["naam"] ?? "");
      const deleted = await db
        .delete(apiKeys)
        .where(eq(apiKeys.name, naam))
        .returning({ name: apiKeys.name });
      if (deleted.length === 0) {
        res.status(404).json({ error: "Onbekende sleutel." });
        return;
      }
      windows.delete(naam);
      void logAction({
        kind: "extern_lezen",
        action: "Leessleutel ingetrokken",
        reason: `sleutel: ${naam}`,
        outcome: "ingetrokken",
      });
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "Leessleutel intrekken mislukt");
      res.status(500).json({ error: "Sleutel kon niet worden ingetrokken." });
    }
  },
);

// Compat: het eerder gekoppelde Connect-blok haalt zijn sleutel hier op.
// Bewuste keuze: dit endpoint staat achter de beheerderslogin en toont de
// sleutel 'status-lees' herhaald aan de (enige) beheerder — de eigenaar van
// alle sleutels. De éénmalige weergave geldt voor de benoemde sleutels.
externAdminRouter.get(
  "/extern/leessleutel",
  async (_req: Request, res: Response) => {
    try {
      const rows = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.name, COMPAT_KEY_NAME));
      if (rows[0]) {
        res.json({ sleutel: rows[0].key });
        return;
      }
      const sleutel = randomBytes(32).toString("base64url");
      await db
        .insert(apiKeys)
        .values({ name: COMPAT_KEY_NAME, key: sleutel })
        .onConflictDoNothing();
      const again = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.name, COMPAT_KEY_NAME));
      if (!again[0]) throw new Error("leessleutel kon niet worden aangemaakt");
      res.json({ sleutel: again[0].key });
    } catch (err) {
      logger.error({ err }, "Leessleutel opvragen mislukt");
      res.status(500).json({ error: "Sleutel kon niet worden opgehaald." });
    }
  },
);
