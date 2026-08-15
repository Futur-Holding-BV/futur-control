# FPS-Beheercentrum

Alleen-lezen beheerscherm dat de status van de FPS GitHub-codebases toont: laatste controle (groen/rood/grijs), laatste push, laatste commit, faalredenen in gewone taal, en waarschuwingen bij ongewoon grote bestandswijzigingen (>300 regels in één bestand).

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

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

- Read-only richting de codebases: alleen GET-verzoeken naar de GitHub API. Eén bewuste uitzondering: het opnieuw starten van een bestaande Actions-run (`rerun-failed-jobs`) — automatisch (max. 1x, alleen bij tijdelijke haperingen) of via een expliciet goedgekeurd voorstel. Nooit: code wijzigen, database aanpassen, productie herstarten of deployen.
- Bewaakte repos: env `MONITORED_REPOS` (kommagescheiden) of anders automatisch alle repos van de org; org uit `GITHUB_ORG`, auth uit `GITHUB_TOKEN` (Secrets).
- "Loopt af"-blok (`lib/expiry.ts`): GitHub-tokenexpiry via de `github-authentication-token-expiration` responseheader; TLS via directe socket (env `EXPIRY_TLS_HOSTS`); domeinverlenging via publieke RDAP (env `EXPIRY_DOMAINS`); Azure-clientsleutel via Microsoft Graph (env `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`). Onleesbaar = severity "unknown" met reden, nooit ok.
- Zelfherstel (`lib/selfheal.ts`): rode run met tijdelijk ogende fout (netwerk/timeout/limiet) → één automatische rerun; melding wordt vastgehouden tot de herhaling klaar is; alles gelogd in `action_log`. Groen na herhaling = badge "hersteld na herhaling".
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
