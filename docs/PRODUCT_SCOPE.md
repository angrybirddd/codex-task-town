# Product scope

## Phase 1: shared studio — task activity

Build a warm shared pixel-art studio showing the work state of each Codex Desktop task. Use window benches, shared work surfaces, bookshelves, a whiteboard and a lounge instead of repeating identical desks. Each task keeps a stable character. Tool events update activities; browser code handles animation without extra model calls.

Reliability takes priority: waiting is not resting; a stopped turn is not project completion; absent telemetry means unknown, not idle. Keep raw prompts, tool output and secrets out of the dashboard. The monitoring integration is read-only and must not approve or block task execution.

## Phase 2: campsite — project progress (deferred)

Only after Phase 1 is complete and validated, add a campsite or village to represent overall project construction progress. Progress must come from explicit milestones or verified deliverables, not from activity counts or how long a character appears busy.

Phase 2 is deliberately not part of the current implementation.
