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
- Routes: `artifacts/api-server/src/routes/repos.ts` (`GET /api/repos`, `GET /api/repos/:name/detail`)
- API-contract: `lib/api-spec/openapi.yaml`

## Architecture decisions

- Strikt read-only: alleen GET-verzoeken naar de GitHub API; geen database, geen opslag van code.
- Bewaakte repos staan hardcoded in `MONITORED_REPOS` in `github.ts`; org komt uit `GITHUB_ORG`, auth uit `GITHUB_TOKEN` (Secrets).
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
