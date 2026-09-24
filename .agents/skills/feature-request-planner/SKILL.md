---
name: feature-request-planner
description: Research and plan a new feature for this repository, clarify material scope boundaries with the requester, and save an implementation-ready plan under docs/features/. Use when a user proposes, requests, or wants to scope a new capability; do not use for direct implementation or small bug fixes.
---

# Feature Request Planner

Turn a proposed capability into a researched, reviewed, implementation-ready
document. Planning does not authorize implementation.

## Workflow

1. Read `AGENTS.md`, `docs/feature-request.md`, ADRs, relevant source, tests, and
   examples. Check the working tree and preserve unrelated changes.
2. Restate the user outcome and identify affected pipeline stages. Research the
   current implementation before proposing changes. For Oracle or dependency
   behavior not established locally, consult current primary documentation and
   record links plus access dates.
3. Separate verified facts, inferences, and open decisions. Evaluate model/version
   compatibility, diagnostics, security, source read-only behavior, deterministic
   output, non-overwriting writes, and unit/integration coverage.
4. Ask only questions whose answers materially change scope, compatibility,
   failure behavior, or acceptance criteria. Offer concrete options and tradeoffs
   derived from the research. Do not write the final plan until the requester has
   answered or explicitly accepted documented assumptions.
5. Incorporate the feedback. Resolve contradictions or ask a focused follow-up.
6. Create `docs/features/YYYY-MM-DD-<kebab-case-feature>.md`, adapting
   `assets/feature-plan-template.md`. Never overwrite an existing plan; add a
   numeric suffix when needed.
7. Verify all referenced repository paths and commands. Report the plan path,
   major decisions, remaining risks, and that implementation has not started.

## Plan Quality

Make the plan usable by a contributor without repeating discovery. Name concrete
modules and tests, describe contract changes field-by-field, define stable failure
behavior, order implementation steps by dependency, and use testable acceptance
criteria. Prefer the smallest change that satisfies the approved outcome.

If the feature conflicts with ADR 0001 invariants, include a required ADR step and
do not silently redefine the architecture. Keep unresolved decisions explicit;
never invent user preferences.

