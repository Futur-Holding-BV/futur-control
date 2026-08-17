# Memory index

- [Orval/zod codegen quirks](orval-zod.md) — use `type: number`, never `integer`, in openapi.yaml; zod 3.25 breaks on generated `zod.int()`.
- [Notification policy invariants](notification-policy.md) — 10-min debounce + Amsterdam quiet window; `notified_status` 'none' vs 'gray' semantics; time-fake all notify tests.
- [Self-heal boundaries](selfheal-boundaries.md) — GitHub rerun-failed-jobs re-executes deploy jobs too; always filter forbidden job names and claim atomically in action_log before the POST.
