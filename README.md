# FPS-Beheercentrum

FPS-Beheercentrum is een Nederlands, alleen-lezen beheerscherm voor de
GitHub-codebases van FPS. Het maakt de technische stand, afwijkingen,
vervalmomenten en meldingen zichtbaar, zodat beheer niet afhankelijk is van
het handmatig bekijken van losse repositories en diensten.

## Waar dit draait

- **Broncode:** [`Futur-Holding-BV/futur-control`](https://github.com/Futur-Holding-BV/futur-control).
- **Productieadres:** onbekend. Er staat geen gepubliceerd domein of URL in
  deze repository of de Replit-instellingen.
- **Platform/server:** Replit Application deployment met het ingestelde target
  `autoscale`. De exacte fysieke server, regio en productiehost zijn onbekend.
- **Onderdelen:** de webapp is `artifacts/beheercentrum`; de API staat onder
  `/api` en draait als apart Replit-artifact op poort 8080.

## Starten en bouwen

Dit is een pnpm-workspace voor Node.js 24 en TypeScript.

```sh
pnpm install
pnpm --filter @workspace/beheercentrum run dev  # webapp
pnpm --filter @workspace/api-server run dev     # API
pnpm run typecheck                              # alle TypeScript-projecten
pnpm run build                                  # typecheck + builds
```

De API heeft `DATABASE_URL` nodig. Wanneer het OpenAPI-contract wijzigt,
genereer dan ook de clients en schema's opnieuw:

```sh
pnpm --filter @workspace/api-spec run codegen
```

De API-testset draait met:

```sh
pnpm --filter @workspace/api-server test -- --run
```

## Kaart van de repository

| Locatie | Inhoud |
| --- | --- |
| `artifacts/beheercentrum/` | React/Vite-beheerscherm. |
| `artifacts/api-server/` | Express-API, GitHub-monitoring, meldingen, zelfherstel en routes. |
| `lib/api-spec/openapi.yaml` | Bron van het API-contract. |
| `lib/api-zod/`, `lib/api-client-react/` | Gegenereerde validatie en frontend-API-client. |
| `lib/db/src/schema/` | Gegevensmodel (Drizzle-tabellen). |
| `lib/db/src/migrate.ts` | Database-initialisatie en compatibele schemawijzigingen. |
| `scripts/` | Werkruimte- en post-mergehulpmiddelen. |
| `replit.md` | Actuele technische afspraken en bedieningsnotities. |

## Uitrollen en controles

Replit bouwt de webapp statisch en start de API met `NODE_ENV=production`. De
API-startcontrole is `GET /api/healthz`. De huidige Replit-configuratie noemt
geen CI-pipeline, releasegoedkeuring, productiedatabase-migratiestap of
productiesmoke-test; die procedure is dus onbekend en mag niet worden
aangenomen.

Voer vóór een productie-uitrol in elk geval de aanwezige controles uit:

```sh
pnpm run typecheck
pnpm run build
pnpm --filter @workspace/api-server test -- --run
```

Bij wijzigingen aan het contract hoort ook `pnpm --filter @workspace/api-spec
run codegen` plus de bijbehorende typecheck en tests. De database-opdracht
`pnpm --filter @workspace/db run push` is volgens `replit.md` alleen voor
ontwikkeling; een productieprocedure staat niet in deze repository.

## Afhankelijkheden en grenzen

De webapp gebruikt deze API; de API gebruikt PostgreSQL en leest status uit de
GitHub-organisatie die via `GITHUB_ORG` is ingesteld. Daarnaast kan zij
Microsoft Graph voor e-mail, Slack als optioneel tweede meldingskanaal, Web
Push, publieke RDAP en TLS-controles gebruiken. Welke concrete andere
bedrijfssystemen door de organisatieconfiguratie worden bewaakt, en welke
systemen op dit beheercentrum leunen, is niet als vaste relatie in de code
vastgelegd.

Benodigde of ondersteunde configuratie staat als Replit Secret, niet in Git:
databaseverbinding, GitHub-token, beheerwachtwoord en sessiegeheim, Graph-mail
instellingen, optionele Slack/Web Push-instellingen en de TLS-/domeinlijsten.
De applicatie bewaakt onder meer GitHub-token-, TLS-, domein- en
Azure-clientsecretverval. De daadwerkelijke sleutels en hun vervaldata zijn
niet in deze repository opgeslagen.

Dit project wijzigt geen broncode, databases, productie-instellingen,
secrets/rechten, firewalls of uitrol van bewaakte systemen. Uitgezonderd is het
opnieuw starten van een bestaande, tijdelijk mislukte GitHub Actions-run binnen
de vastgelegde zelfherstelgrens. Werk aan een bewaakt product hoort in de
repository van dat product; monitorlogica en beheerweergave horen hier.