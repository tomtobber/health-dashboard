# Recurring Mistakes Log

Purpose: close the feedback loop that `.agentrules` alone can't. Static rules only
cover mistakes you already anticipated. This log tracks mistakes the agent actually
made in this codebase, so patterns get promoted into `.agentrules` instead of getting
re-fixed by hand every few weeks.

The AI agent should read this file (alongside `.agentrules` / `AGENTS.md`) before starting work, and
check its own diff against it during the Tier-2 self-review pass.

## How to add an entry
Whenever a human reviewer (or CI) catches something the agent should have caught
itself, add a row below. Keep it terse — one line, not a postmortem.

Date	Pattern	Where it showed up	Status

## Status values
- `Logged` — happened once, watching for a repeat before promoting it to a rule.
- `Promoted to rule #N` — happened 2+ times or was severe enough to add directly to `.agentrules`. Reference the rule number it was folded into.
- `Won't fix` — one-off, not worth a standing rule (note why).

## Promotion criteria
Promote an entry from the log into `.agentrules` when either is true:
- The same category of mistake appears twice, even in different files.
- A single occurrence caused a production incident or a failed deploy.

Don't promote single, low-severity one-offs — the goal is a short, high-signal rules
file, not an ever-growing list nobody reads. If `.agentrules` starts exceeding ~15
rules, look for entries that can be merged or generalized rather than piling on more.

## Review cadence
Review this log every 2 weeks (or every ~20 PRs, whichever comes first):
- Scan for any `Logged` entries that have recurred — promote them.
- Prune `Won't fix` entries older than 90 days to keep the file signal-dense.
- If `.agentrules` was updated, note the rule change in the entry so there's a trail
  from "mistake happened" to "rule changed."

## Log
<!-- Add new entries above this line, most recent first -->
Date	Pattern	Where it showed up	Status
2026-08-08	Error subclass properties set via super() inherit non-enumerable behavior, breaking JSON serialization silently — passes tests that check .message directly but fails tests that check serialized output	src/errors/AppError.ts	Promoted to rule #2
2026-08-08	`crypto.timingSafeEqual` called without comparing buffer lengths first	src/services/cryptoService.ts	Logged
2026-08-08	Drizzle ORM `sql` imported from `drizzle-orm/pg-core` instead of `drizzle-orm`	src/db/schema.ts	Logged
2026-08-01	Example: agent used `res.data.items[0]` without checking the array was non-empty	src/api/orders.ts	Promoted to rule #5