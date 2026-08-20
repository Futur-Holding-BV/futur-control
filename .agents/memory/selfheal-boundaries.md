---
name: Self-heal boundaries
description: Safety and immutability rules for automatic GitHub recovery actions
---

Rule: Same-version deploy/release reruns are allowed, but rollback, migration, backup restore, settings, secrets, permissions and firewall mutations are never automatic. Inspect the exact workflow definition used by the failed run, including dependent jobs—not only the failed job name.

Service restart dispatch is allowed only through an explicitly mapped repo and a parsed workflow named exactly `herstart` with `workflow_dispatch`, loaded and dispatched from a GitHub-enforced immutable Release tag.

**Why:** GitHub’s failed-job rerun can also execute dependent jobs. Workflow dispatch accepts mutable branch/tag names but not commit SHAs; an immutable Release tag prevents a reviewed restart workflow changing between validation and execution.

**How to apply:** every external execution must consume an attempt through durable compare-and-swap incident state before the API call, remain capped at three executions across crashes/concurrency, and write its audit entry before acting. Fail closed when the exact workflow or immutable restart target cannot be verified.
