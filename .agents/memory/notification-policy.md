---
name: Notification policy invariants
description: Debounce/quiet-window rules the monitor must keep honoring
---

- Slack notifications only after a problem (red OR gray) persists ≥10 min; blips go to the action log (`melding_onderdrukt`), never Slack.
- Quiet window Europe/Amsterdam: 22:00–07:15 Mon–Fri, 22:00–09:00 Sat–Sun; deferred problems go out on the first allowed poll (existing bundling covers the summary message).
- `notified_status` semantics changed: `gray` in stored rows = already-notified problem; missing row defaults to `none`. Never reintroduce `gray` as the "never notified" default.
- **Why:** operators demanded no night-time pings and no alerts for sub-10-min hiccups; gray counts as a problem, not rest.
- **How to apply:** any monitor test that decides whether to notify MUST fake the system time (real clock makes tests fail at night/weekend mornings).
