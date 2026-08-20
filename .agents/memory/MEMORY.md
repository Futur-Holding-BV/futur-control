# Memory index

- [Orval/zod codegen quirks](orval-zod.md) — use `type: number`, never `integer`, in openapi.yaml; zod 3.25 breaks on generated `zod.int()`.
- [Notification policy invariants](notification-policy.md) — 10-min debounce + Amsterdam quiet window; `notified_status` 'none' vs 'gray' semantics; time-fake all notify tests.
- [Self-heal boundaries](selfheal-boundaries.md) — verify exact workflows and dependent jobs; restarts require a safe `herstart` workflow on an immutable Release tag.
