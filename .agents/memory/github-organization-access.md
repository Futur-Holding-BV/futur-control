---
name: GitHub organization access
description: How to reason about differing organization permissions between shell Git credentials and Replit's bound GitHub connection.
---

Treat shell Git credentials and the bound Replit GitHub connection as independent authorization paths. A rejected HTTPS push does not prove that the connected GitHub account lacks repository write access.

**Why:** Existing workspace tokens authenticated successfully but lacked organization access, while the bound GitHub connection for the same user had explicit `repo` scope and admin/push permission on the organization repositories.

**How to apply:** Verify the target repository's current permissions through the bound connection before declaring a push blocked. Prefer ordinary non-force Git pushes when shell credentials work; never extract connector credentials or infer connector scopes from the shell identity.