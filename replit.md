# FPS-Beheercentrum

Alleen-lezen beheerscherm dat de status van de FPS GitHub-codebases toont: laatste controle (groen/rood/grijs), laatste push, laatste commit, faalredenen in gewone taal, en waarschuwingen bij ongewoon grote bestandswijzigingen (>300 regels in één bestand).

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Iedere afgeronde taak wordt zonder force-push naar de hoofdtak van de passende `Futur-Holding-BV`-repository gepusht. Controleer vóór de push altijd eerst of remote `main` intussen is gewijzigd.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- Frontend: `artifacts/beheercentrum` (React + Vite, wouter, Dutch UI, dark theme)
- GitHub-client (read-only): `artifacts/api-server/src/lib/github.ts`
- Routes: `artifacts/api-server/src/routes/` — repos (`/api/repos`, `/api/repos/:name/detail`), expiry (`/api/expiry`), actions (`/api/actions/log`, `/api/actions/proposals`, `POST /api/actions/proposals/:id/execute`)
- Zelfherstel & logboek: `artifacts/api-server/src/lib/selfheal.ts`, `actionlog.ts`, `proposals.ts`, `expiry.ts`; DB-tabel `action_log`
- API-contract: `lib/api-spec/openapi.yaml`

## Architecture decisions

- Read-only richting de codebases: alleen GET-verzoeken naar de GitHub API. Veilige uitzonderingen zijn maximaal drie pogingen om een bestaande mislukte Actions-run te herhalen en, alleen via een vooraf gecontroleerde immutable Release-workflow `herstart`, een expliciet gekoppelde dienst te herstarten. Nooit automatisch: code wijzigen, database wijzigen of herstellen, terugrollen, instellingen/geheimen/rechten/firewalls aanpassen of een willekeurige uitrol starten.
- Bewaakte repos: standaard automatisch alle (ook later toegevoegde) repos van `GITHUB_ORG`, met auth uit `GITHUB_TOKEN` (Secrets). Een beperkende `MONITORED_REPOS`-override blijft mogelijk, maar opent zichtbaar een bevinding voor iedere uitgesloten organisatierepository.
- De operationele Connect-koppeling gebruikt uitsluitend het minimale HTTPS-adres uit `CONNECT_STATUS_URL`; de GitHub-repository is standaard `FPS-Connect` en kan expliciet met `CONNECT_GITHUB_REPO` worden ingesteld.
- "Loopt af"-blok (`lib/expiry.ts`): GitHub-tokenexpiry via de `github-authentication-token-expiration` responseheader; TLS via directe socket (env `EXPIRY_TLS_HOSTS`); domeinverlenging via publieke RDAP (env `EXPIRY_DOMAINS`); Azure-clientsleutel via Microsoft Graph (env `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`). Onleesbaar = severity "unknown" met reden, nooit ok.
- Zelfherstel (`lib/selfheal.ts`): een tijdelijke bouw- of dienststoring krijgt maximaal drie duurzaam geclaimde veilige pogingen; meldingen worden vastgehouden zolang veilig herstel nog loopt en volgen pas na uitputting of een verboden/onveilige uitkomst. Alles staat in `action_log`.
- Achtergrondmonitor, dagberichtklok, watchdog en andere meldtimers starten uitsluitend met `NODE_ENV=production`; preview- en taakomgevingen mogen nooit operationele meldingen versturen.
- Rond 17:00 Amsterdam gaat op iedere werkdag exact één dagbericht uit, ook zonder problemen, met open punten, zelf opgelost werk, verloop binnen 30 dagen en de vijf Connect-controles.
- Voorstellen (`lib/proposals.ts`): stateless berekend, id codeert repo+runId zodat verouderde knoppen een 404 geven; uitvoeren alleen via POST na gebruikersklik.
- Status komt van GitHub Actions workflow runs: success→groen, failure/timed_out→rood, geen runs of lopend→grijs.
- Faalreden wordt vertaald naar gewone taal via naam van de gefaalde job/stap (typecheck/tests/lint/build/...).
- Afwijking: laatste commit waarin één bestand >300 regels groeit of krimpt (additions+deletions).

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
