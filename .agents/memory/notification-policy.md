---
name: Notification policy invariants
description: Finding levels, delivery timing, and anti-duplicate rules the monitor must keep honoring
---

- All user-facing monitor events first become persistent findings. Their database-configured level decides delivery across mail, Slack, and push: `NU` is immediate; `KAN_WACHTEN` appears only in the weekday 17:00 report.
- Quiet window Europe/Amsterdam: 22:00–07:15 Mon–Fri, 22:00–09:00 Sat–Sun. Deferred open `NU` findings go out at the first allowed check.
- Automatically or naturally resolved findings remain visible/logged but are never delivered. Reopening starts a new delivery cycle.
- Public-service unavailability becomes a finding only after three failed measurements spanning at least ten minutes.
- Immediate delivery needs a dedicated cross-instance claim/lock because the independent heartbeat watchdog and the normal monitor can both attempt delivery.
- `notified_status` remains repo-monitor bookkeeping: `gray` means an already-recorded problem; missing rows default to `none`.
- **Why:** users should receive only actionable alerts, with no night-time pings, transient-service noise, recovered-incident mail, or multi-instance duplicates.
- **How to apply:** centralize new alert types in the findings policy, and fake Amsterdam-aware clock times in all delivery tests.

## Mail channel (Microsoft Graph)
Delivered-state OR-semantics: slack || push || mail. A mail that fails to send but is
persisted in mail_outbox counts as HANDLED (delivered=true) — the outbox owns the retry
each monitor cycle. Counting "queued" as not-delivered makes the monitor resend and
re-queue the same alert every poll (duplicate mails, attempt counter resets after the
max-attempt purge). Only "off" (unconfigured) and "failed" (not even queueable) return false.

## Runtime boundary
Only the published production service may start monitor, watchdog, or delivery timers.

**Why:** Main previews and isolated task-agent environments can run simultaneously with
the same mail secrets but separate databases; database locks cannot deduplicate across
those environments, so every environment would send its own copy.

**How to apply:** Keep all operational background jobs behind the production runtime
gate. Preview and test environments may serve APIs and run explicit tests, but must not
send scheduled or monitor-triggered notifications.

The weekday daily report is the exception to treating HANDLED as delivery proof:
queued-only mail is HANDLED for anti-duplicate ownership but remains unconfirmed until
Graph accepts an outbox retry. Keep separate pending/confirmed state and advance the
confirmed date monotonically when delayed reports arrive.

**Why:** an outbox row proves durable retry ownership, not operator delivery. Counting
it as the daily heartbeat would hide a broken mail path; retrying the whole report would
instead duplicate mail.

**How to apply:** daily-report overdue checks use Amsterdam workdays and probe the live
monitor advisory lock before counting today. Never use a persisted "poll active" flag:
it can survive a process crash after PostgreSQL has already released the real lock.
