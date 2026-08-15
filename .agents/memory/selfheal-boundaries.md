---
name: Self-heal boundaries
description: Hard rules for the beheercentrum's automatic/one-tap GitHub Actions reruns
---

Rule: `rerun-failed-jobs` re-executes whatever failed — including deploy/release/migration jobs. Any rerun path (automatic or button) must first check job/workflow names against `rerunForbidden()` in `artifacts/api-server/src/lib/selfheal.ts`.

**Why:** the user's hard boundary is that the beheercentrum never deploys, restarts production, or changes code/database. A naive rerun of a failed "Deploy naar productie" workflow would redeploy.

**How to apply:** any new action type must (1) pass the forbidden-name filter at proposal time AND execute time, and (2) claim atomically by inserting into `action_log` first (unique partial index on repo+run_id for auto_retry) — no claim, no action. The execute route has no authentication yet; treat that as an open user decision before adding more powerful actions.
