import { createHmac, timingSafeEqual } from "node:crypto";

const DIRECTE_HANDELINGEN = new Set([
  "POST:/api/auth/login",
  "POST:/api/auth/mobile/login",
  "POST:/api/uren",
  "PATCH:/api/uren/:id",
  "POST:/api/facturen/:id/verzenden-klant",
  "POST:/api/betaalbatches/:id/bevestigen",
]);

export type SentryMeldsoort = "direct" | "dagbundel";

export function classificeerSentryHandeling(
  handeling: string | null,
): SentryMeldsoort {
  return handeling !== null && DIRECTE_HANDELINGEN.has(handeling)
    ? "direct"
    : "dagbundel";
}

function veiligKenmerk(waarde: unknown, max = 120): string | null {
  if (typeof waarde !== "string") return null;
  const schoon = waarde.trim();
  return schoon.length > 0 &&
    schoon.length <= max &&
    /^[a-zA-Z0-9_.:/+-]+$/.test(schoon)
    ? schoon
    : null;
}

function veiligIssueKey(waarde: unknown): string | null {
  return typeof waarde === "string" && /^\d{1,30}$/.test(waarde)
    ? waarde
    : typeof waarde === "number" && Number.isSafeInteger(waarde) && waarde > 0
      ? String(waarde)
      : null;
}

function veiligEventKey(waarde: unknown): string | null {
  return typeof waarde === "string" && /^[0-9a-f]{32}$/i.test(waarde)
    ? waarde.toLowerCase()
    : null;
}

function veiligComponent(waarde: string | undefined): string {
  return waarde && ["api", "firevault", "monteur-app"].includes(waarde)
    ? waarde
    : "onbekend";
}

function veiligHandelingslabel(waarde: string | undefined): string | null {
  if (!waarde) return null;
  return waarde === "overig" ||
    /^(?:DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT):\/[a-zA-Z0-9_./:-]{1,120}$/.test(
      waarde,
    )
    ? waarde
    : null;
}

function veiligeOmgeving(waarde: unknown): string | null {
  return typeof waarde === "string" &&
    ["development", "preview", "production", "staging", "test"].includes(waarde)
    ? waarde
    : null;
}

function veiligeRelease(waarde: unknown): string | null {
  return typeof waarde === "string" && /^[0-9a-f]{7,64}$/i.test(waarde)
    ? waarde
    : null;
}

function leesTags(event: Record<string, unknown>): Map<string, string> {
  const resultaat = new Map<string, string>();
  const tags = event["tags"];
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (!tag || typeof tag !== "object") continue;
      const bron = tag as Record<string, unknown>;
      const sleutel = veiligKenmerk(bron["key"] ?? bron["name"], 80);
      const waarde = veiligKenmerk(bron["value"], 160);
      if (sleutel && waarde) resultaat.set(sleutel, waarde);
    }
  } else if (tags && typeof tags === "object") {
    for (const [sleutel, waarde] of Object.entries(
      tags as Record<string, unknown>,
    )) {
      const veilig = veiligKenmerk(waarde, 160);
      if (veilig) resultaat.set(sleutel, veilig);
    }
  }
  return resultaat;
}

function veiligSentryUrl(waarde: unknown): string | null {
  if (typeof waarde !== "string") return null;
  try {
    const url = new URL(waarde);
    if (
      url.protocol !== "https:" ||
      !(url.hostname === "sentry.io" || url.hostname.endsWith(".sentry.io"))
    ) {
      return null;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export interface VeiligSentrySignaal {
  issueKey: string;
  eventKey: string | null;
  project: string;
  component: string;
  handeling: string | null;
  omgeving: string | null;
  release: string | null;
  verwijzingscode: string | null;
  routingBewijs: string | null;
  issueUrl: string | null;
}

export function leesVeiligSentrySignaal(
  payload: unknown,
): VeiligSentrySignaal | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as Record<string, unknown>)["data"];
  if (!data || typeof data !== "object") return null;
  const dataObject = data as Record<string, unknown>;
  const eventWaarde = dataObject["event"];
  if (!eventWaarde || typeof eventWaarde !== "object") return null;
  const event = eventWaarde as Record<string, unknown>;
  const issueWaarde = dataObject["issue"] ?? event["issue"];
  const issue =
    issueWaarde && typeof issueWaarde === "object"
      ? (issueWaarde as Record<string, unknown>)
      : {};
  const projectWaarde = event["project"] ?? issue["project"];
  const projectObject =
    projectWaarde && typeof projectWaarde === "object"
      ? (projectWaarde as Record<string, unknown>)
      : {};
  const tags = leesTags(event);

  const issueKey = veiligIssueKey(
    issue["id"] ??
      event["groupID"] ??
      event["groupId"] ??
      event["issueId"],
  );
  const project =
    veiligKenmerk(projectObject["slug"] ?? projectWaarde, 80) ?? "onbekend";
  if (!issueKey) return null;

  return {
    issueKey,
    eventKey: veiligEventKey(
      event["event_id"] ?? event["eventID"] ?? dataObject["event_id"],
    ),
    project,
    component: veiligComponent(tags.get("component")),
    handeling: veiligHandelingslabel(tags.get("handeling")),
    omgeving:
      veiligeOmgeving(event["environment"]) ??
      veiligeOmgeving(tags.get("environment")),
    release:
      veiligeRelease(event["release"]) ??
      veiligeRelease(tags.get("release")),
    verwijzingscode:
      /^FPS-[A-Z0-9]{8}$/.test(tags.get("verwijzingscode") ?? "")
        ? (tags.get("verwijzingscode") ?? null)
        : null,
    routingBewijs:
      /^[0-9a-f]{64}$/i.test(tags.get("routing_bewijs") ?? "")
        ? (tags.get("routing_bewijs")?.toLowerCase() ?? null)
        : null,
    issueUrl: veiligSentryUrl(
      issue["permalink"] ?? issue["webUrl"] ?? event["web_url"],
    ),
  };
}

export function isVertrouwdeDirecteSentryMelding(
  signaal: Pick<
    VeiligSentrySignaal,
    | "component"
    | "handeling"
    | "omgeving"
    | "project"
    | "routingBewijs"
    | "verwijzingscode"
  >,
  geheim: string | undefined,
  apiProject: string | undefined,
): boolean {
  if (
    !geheim ||
    geheim.length < 32 ||
    !apiProject ||
    signaal.project !== apiProject ||
    signaal.component !== "api" ||
    signaal.omgeving !== "production" ||
    !signaal.verwijzingscode ||
    !signaal.routingBewijs ||
    classificeerSentryHandeling(signaal.handeling) !== "direct"
  ) {
    return false;
  }
  const verwacht = createHmac("sha256", geheim)
    .update(`${signaal.verwijzingscode}:${signaal.handeling}`)
    .digest();
  const ontvangen = Buffer.from(signaal.routingBewijs, "hex");
  return ontvangen.length === verwacht.length &&
    timingSafeEqual(ontvangen, verwacht);
}

export function leesOpgelostIssueKey(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const bron = payload as Record<string, unknown>;
  if (bron["action"] !== "resolved" && bron["action"] !== "archived") {
    return null;
  }
  const data = bron["data"];
  if (!data || typeof data !== "object") return null;
  const issue = (data as Record<string, unknown>)["issue"];
  if (!issue || typeof issue !== "object") return null;
  return veiligIssueKey((issue as Record<string, unknown>)["id"]);
}