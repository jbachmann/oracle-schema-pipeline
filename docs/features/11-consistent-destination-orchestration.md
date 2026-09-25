# Feature: Consistent destination orchestration

Operational policy update: [feature 14](14-remote-schema-local-clone.md) and
[ADR 0008](../adr/0008-disposable-local-destination-orchestration.md) supersede
the preserve-existing-destination proposal for `db:clone`: successful generation
authorizes replacement of the fixed local Compose destination and its volume.

- Status: Draft request — captured from architecture review; not approved for implementation
- Date: 2026-09-24
- Priority: Medium
- Request: Ensure destination checks, SQL execution, and verification target the same database.

## Context and Scope

Given a destination override, orchestration either uses that same destination for
all operations or rejects the configuration before replay. It must never inspect
one database and execute against another.

Affected components: Compose clone/reset scripts and integration orchestration.
Exclude changing production pipeline stages or adding general remote deployment.

This request captures the user's authorized review recommendations. Design defaults
below are proposals, not approved implementation decisions. Implementation has not
started. Resolve material open questions before promoting this request to Planned.

## Research Findings

Verified: `scripts/clone-compose-database.ts` uses ORACLE_DESTINATION_DSN for its
schema-count guard, then replays SQL through the fixed oracle-destination container.
The integration test similarly permits a DSN override while replay/reset targets
that container. Subprocess and SQL*Plus helpers are duplicated.

Repository paths refer to the implementation reviewed on 2026-09-24. The review
passed `npm test` (32 tests) and `npm run typecheck`; live integration was inspected,
not executed.

## Decisions and Boundaries

Proposed smallest default: keep these helpers Compose-only and reject external
DSN overrides rather than implement remote execution. Use the published listener
for readback and the same resolved Compose service for execution. Preserve the
clone script's refusal to overwrite/drop existing schemas. This compatibility
change requires explicit documentation; final destination policy remains open.

Preserve read-only extraction, offline transform/validate/generate, trusted SQL
fragment boundaries, independent generation validation, deterministic ordering,
non-overwriting artifacts, and secret exclusion. Invariant exceptions: none proposed.

## Proposed Design

Introduce a destination descriptor resolved once, containing Compose project/service
identity and published connection details. Pass it to inspection, replay, reset,
and verification helpers. Centralize subprocess exit/error handling and SQL*Plus
invocation in a small scripts module; keep secrets out of arguments and errors.
Proposed configuration error: DESTINATION_CONFIGURATION_MISMATCH.

No source/target model change. Clarify README that destination orchestration is
operational tooling; the extract-only connection invariant applies to core pipeline
commands, not these explicit destination helpers.

## Implementation Plan

1. Confirm Compose-only versus complete remote support before implementation.
2. Add non-mutating mocked command-routing tests in a new scripts test file.
3. Extract shared operational helpers and update `scripts/clone-compose-database.ts`,
   `scripts/reset-compose-destination.ts`, and `test/integration/oracle-roundtrip.test.ts`.
4. Document supported environment variables and migration from rejected overrides.

## Test Plan

Test default Compose resolution, mismatched/unsupported overrides, named Compose
projects, missing ports, process failures, and guard failure before replay. Mock
routing tests must never invoke destructive commands. Verify successful integration
only against disposable destination services.

Run `npm test` and `npm run typecheck`. Run `npm run build` for module/interface
changes. Catalog or generated-SQL changes also require `npm run test:integration`
against disposable Oracle services.

## Acceptance Criteria

- [ ] Guard, replay, and verification consume one resolved destination.
- [ ] Unsupported overrides fail before any replay/reset action.
- [ ] Clone retains its refusal to overwrite existing managed schemas.
- [ ] Errors and subprocess arguments do not expose credentials.
- [ ] Existing pipeline invariants and stated compatibility behavior remain covered.
- [ ] README and relevant architecture decisions describe the final behavior.

## Risks and Open Questions

Requester confirmation is needed before removing override behavior or expanding
to remote execution. A shared descriptor reduces configuration drift but does not
by itself establish database identity after external infrastructure changes.
