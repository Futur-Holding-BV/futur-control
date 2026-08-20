import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  classificeerSentryHandeling,
  isDagbundelMoment,
  isVertrouwdeDirecteSentryMelding,
  leesOpgelostIssueKey,
  leesVeiligSentrySignaal,
  magDirectMelden,
} from "./sentryPolicy.js";

describe("classificeerSentryHandeling", () => {
  it.each([
    "POST:/api/auth/login",
    "POST:/api/auth/mobile/login",
    "POST:/api/uren",
    "PATCH:/api/uren/:id",
    "POST:/api/facturen/:id/verzenden-klant",
    "POST:/api/betaalbatches/:id/bevestigen",
  ])("classificeert alleen de expliciete blokkade direct: %s", (handeling) => {
    expect(classificeerSentryHandeling(handeling)).toBe("direct");
  });

  it.each([
    null,
    "GET:/api/auth/login",
    "POST:/api/uren/tijd-voor-tijd-aanvraag",
    "POST:/api/facturen/:id/definitief",
    "POST:/api/betaalbatches",
    "overig",
  ])("bundelt iedere andere handeling: %s", (handeling) => {
    expect(classificeerSentryHandeling(handeling)).toBe("dagbundel");
  });
});

describe("beheercentrumvensters in Europe/Amsterdam", () => {
  it("opent werkdagen om 07:15 en sluit om 17:00", () => {
    expect(magDirectMelden(new Date("2026-08-20T05:14:00Z"))).toBe(false);
    expect(magDirectMelden(new Date("2026-08-20T05:15:00Z"))).toBe(true);
    expect(magDirectMelden(new Date("2026-08-20T14:59:00Z"))).toBe(true);
    expect(magDirectMelden(new Date("2026-08-20T15:00:00Z"))).toBe(false);
  });

  it("opent in het weekend om 09:00", () => {
    expect(magDirectMelden(new Date("2026-08-22T06:59:00Z"))).toBe(false);
    expect(magDirectMelden(new Date("2026-08-22T07:00:00Z"))).toBe(true);
  });

  it("bundelt alleen in de vijfminutenmarge vanaf 17:00", () => {
    expect(isDagbundelMoment(new Date("2026-08-20T14:59:00Z"))).toBe(false);
    expect(isDagbundelMoment(new Date("2026-08-20T15:00:00Z"))).toBe(true);
    expect(isDagbundelMoment(new Date("2026-08-20T15:04:00Z"))).toBe(true);
    expect(isDagbundelMoment(new Date("2026-08-20T15:05:00Z"))).toBe(false);
  });
});

describe("minimale Sentry-invoer", () => {
  it("neemt alleen routeringsvelden uit het event over", () => {
    expect(
      leesVeiligSentrySignaal({
        data: {
          event: {
            event_id: "0123456789abcdef0123456789abcdef",
            groupID: "12345",
            environment: "production",
            release: "abc1234",
            tags: [
              { key: "component", value: "api" },
              { key: "handeling", value: "POST:/api/uren" },
              { key: "email", value: "rene@example.nl" },
            ],
          },
          issue: {
            id: "12345",
            permalink: "https://futur-holding.sentry.io/issues/12345/?secret=x",
            project: { slug: "fps-connect-api" },
          },
        },
      }),
    ).toEqual({
      issueKey: "12345",
      eventKey: "0123456789abcdef0123456789abcdef",
      project: "fps-connect-api",
      component: "api",
      handeling: "POST:/api/uren",
      omgeving: "production",
      release: "abc1234",
      verwijzingscode: null,
      routingBewijs: null,
      issueUrl: "https://futur-holding.sentry.io/issues/12345/",
    });
  });

  it("herkent uitsluitend opgelost of gearchiveerd als herstel", () => {
    const data = { issue: { id: "12345" } };
    expect(leesOpgelostIssueKey({ action: "resolved", data })).toBe("12345");
    expect(leesOpgelostIssueKey({ action: "unresolved", data })).toBeNull();
  });
});

describe("vertrouwde directe bron", () => {
  const geheim = "test-router-geheim-met-minstens-32-tekens";
  const verwijzingscode = "FPS-3A9C1B04";
  const handeling = "POST:/api/uren";
  const routingBewijs = createHmac("sha256", geheim)
    .update(`${verwijzingscode}:${handeling}`)
    .digest("hex");
  const signaal = {
    project: "fps-connect-api",
    component: "api",
    handeling,
    omgeving: "production",
    verwijzingscode,
    routingBewijs,
  };

  it("accepteert alleen een correct getekende directe API-handeling", () => {
    expect(
      isVertrouwdeDirecteSentryMelding(
        signaal,
        geheim,
        "fps-connect-api",
      ),
    ).toBe(true);
  });

  it("weigert hetzelfde label uit web/mobiel, een andere projectbron of een vals bewijs", () => {
    expect(
      isVertrouwdeDirecteSentryMelding(
        { ...signaal, component: "firevault" },
        geheim,
        "fps-connect-api",
      ),
    ).toBe(false);
    expect(
      isVertrouwdeDirecteSentryMelding(
        { ...signaal, project: "fps-connect-web" },
        geheim,
        "fps-connect-api",
      ),
    ).toBe(false);
    expect(
      isVertrouwdeDirecteSentryMelding(
        { ...signaal, routingBewijs: "0".repeat(64) },
        geheim,
        "fps-connect-api",
      ),
    ).toBe(false);
  });
});