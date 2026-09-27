# Integration test failure investigation and resolution plan

Date: 2026-09-27

Scope: investigate `npm run test:integration` on the current working tree and
plan repairs. No application, test, or Compose configuration changes were made.
The existing staged SQL preparation changes were preserved.

## Findings

The initial complete run failed all four enabled integration tests; the
operational local-clone test was skipped, as expected without
`ORACLE_LOCAL_CLONE_INTEGRATION=1`.

| Test                                         | Observed failure                                                              | Explanation                                                                                                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generated SQL reconstructs the seeded source | Expected three boundary columns on `IAM.PERMISSIONS`, received `[]`           | Source fixture validation ran before seeding completed. Failure is at `oracle-roundtrip.test.ts:217`, before extraction or generation.                                    |
| View restriction facts agree with Oracle     | `ORA-01918: user 'CATALOG' does not exist`                                    | This test assumes the first test has created destination schemas. The first test failed before replay, leaving a fresh destination empty.                                 |
| Restricted ALL catalog sessions              | `ORA-00439: feature not enabled: Enterprise User Security` during proxy login | Reader accounts/proxy setup were not yet ready. The same login and privilege checks passed after seeding completed; this does not establish an Oracle edition limitation. |
| Bounded catalog batches                      | The same `ORA-00439` during `SYSTEM[SCHEMA_READER]` login                     | Uses the same source fixture and has no independent readiness gate.                                                                                                       |

The source startup log reports seeding began at `04:54:22.996 UTC` and completed
at `04:54:39.192 UTC`. Later read-only catalog checks confirmed all four schema
owners, both reader accounts, 98 tables, and the completion sequence. TCP queries
confirmed that the discovered source and destination listeners reached the
intended containers. The destination initially had no application schemas.

### Source health check can report success on an SQL error

`test/docker/docker-compose.yml:30` runs SQL*Plus without `WHENEVER SQLERROR` or
`WHENEVER OSERROR`, then accepts any output containing `READY` with
`grep -q READY`. The query itself contains the text `'READY'`.

A read-only diagnostic reproduced the problem: a deliberately invalid `SELECT`
containing the same `then 'READY' else 'WAIT'` expression returned `ORA-00942`,
echoed the query (including `READY`), and SQL*Plus exited with status zero.
That output satisfies the current grep. Thus Compose health can succeed even
though the readiness query failed. The exact early health-check error from the
initial run was not retained in Docker's rolling health log; attributing that
particular startup event to this mechanism is an inference, supported by the
observed premature fixture access and the reproduced false-positive mechanism.

The destination health check already uses explicit SQL/OS error exits and a
whole-line readiness match (`test/docker/docker-compose.yml:48`).

### Listener readiness is weaker than fixture readiness

`test/scripts/readiness.ts:17` only runs `SELECT 1 FROM dual` as `SYSTEM`.
Successful login does not establish that seed objects or restricted reader grants
exist. The source fixture is created by a startup script after database startup.
The same gap applies when `ORACLE_INTEGRATION_USE_EXISTING=1` bypasses Compose
startup entirely.

### Tests depend on another test's successful setup

Compose startup and readiness checks live inside the round-trip test
(`oracle-roundtrip.test.ts:202`). The view restriction test assumes destination
owner `CATALOG` exists (`:403`), while the two reader tests immediately open proxy
sessions (`:506`, `:567`). This turns one setup failure into several misleading
failures and prevents reliable execution of individual tests by name.

## Resolution plan

1. **Make source health fail closed.** Replace the source's inline health command
   with a readable multiline check. Add fixed nonzero SQL/OS error exits, require
   an exact whitespace-tolerant `READY` line, and preserve the SQL*Plus failure
   status. Emit readiness only after validating the PDB and fixture. Retain
   checks for 98 tables, five views, and the final seed marker; include both reader
   accounts and expected proxy relationships. Apply this only to the dedicated
   test Compose project.

2. **Add a shared source fixture readiness gate.** Extend the test readiness
   helpers with bounded, read-only polling over the discovered TCP listener.
   Verify the PDB, seed marker, object counts, reader users, and proxy access.
   Keep the existing independent semantic assertions after readiness succeeds.
   Run this gate even with `ORACLE_INTEGRATION_USE_EXISTING=1`. Report a concise
   setup timeout with missing fixture conditions and sanitized Oracle codes;
   never print passwords or connection secrets.

3. **Move common setup out of the round-trip test.** Use a suite setup hook or
   shared fixture initialization that runs for every selected test. Start the
   explicit test Compose services once and wait for their respective readiness
   conditions. Make a failed setup prevent dependent tests from executing rather
   than producing separate login/schema failures. Reuse source fixture readiness
   in the opt-in clone suite and other seeded helpers where needed.

4. **Give the view test its own destination fixture.** Provision a dedicated
   passwordless owner with the required quota in the disposable test destination,
   create the probe objects there, and clean up in `finally`. Avoid relying on
   `CATALOG` having been created by round-trip replay. Keep all probe DDL/DML on
   the destination and source inspection read-only.

5. **Add focused regression coverage and verify startup behavior.** Check that
   SQL errors echoing `READY`, `WAIT`, incomplete fixtures, and missing reader
   grants cannot pass readiness, and that complete fixtures do pass. Verify
   timeout diagnostics and connection cleanup. Run each integration test by name
   to establish setup independence. Then run the whole suite against a fresh
   dedicated test database and again against an already-running seeded pair,
   including the existing-services flag. Fresh-volume recreation must be limited
   to explicitly disposable test resources. Run the opt-in operational suite
   separately only when its fixed destination is available for its ownership
   checks.

Acceptance criteria: fresh startup waits for complete seeding; SQL errors cannot
produce healthy status; individual tests have their own prerequisites; a setup
failure has a clear setup diagnostic; four default integration tests pass on both
fresh and warm runs, with the operational test explicitly skipped by default.

## Validation and limits

- `npm test`: 225 passed, zero failed.
- `npm run typecheck`: passed.
- Initial complete integration run: zero passed, four failed, one skipped.
- After confirmed seed completion: four passed, zero failed, one skipped in
  237.5 seconds, without code changes. This includes round-trip reconstruction,
  view restriction replay, restricted-account checks, and catalog batching.
- No source reset, volume deletion, or operational clone test was performed.
  The standard integration command started the dedicated test services and
  replayed generated SQL into its disposable destination.
- The initial failures do not implicate the staged SQL rendering changes:
  they occurred before rendering, and the seeded rerun completed SQL replay and
  reconstruction comparison. This is evidence for the tested fixture, not a
  guarantee of untested Oracle features.
