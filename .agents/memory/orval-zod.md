---
name: Orval/zod codegen quirks
description: OpenAPI spec conventions required for the lib/api-spec codegen to work
---

Rule: in `lib/api-spec/openapi.yaml` use `type: number` instead of `type: integer`.

**Why:** orval 8.x generates `zod.int()` for `integer`, which does not exist in the zod 3.25 used by `@workspace/api-zod` — codegen output then fails typecheck.

**How to apply:** whenever adding numeric fields to the spec, declare them `type: number`; run `pnpm --filter @workspace/api-spec run codegen` after every spec change.
