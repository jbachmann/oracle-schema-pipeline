# Feature: Skip existing schemas during creation

- Status: Implemented
- Date: 2026-09-28
- Request: With `createSchemas=true`, create missing schemas and skip each schema
  that already exists, continuing with the remaining commands.

## Context and Scope

The requester encounters the local clone setup error that schema `SYS` already
exists. They explicitly chose skipping existing schemas as the default, without
an additional opt-in setting. Only schema creation becomes conditional; existing
tables, indexes, constraints, and other objects retain their current behavior.

Affected stages: SQL preparation/generation and local destination setup
verification. Extraction, transformation, and semantic validation retain their
existing rules, including restrictions on external prerequisites.

Existing users must retain their authentication, privileges, default tablespace,
and quota. No `ALTER USER`, dropping, or recreating existing accounts is included.
Missing users retain the existing schema-only creation settings. This is not
general replay idempotency or a migration mechanism.

## Research Findings

Repository behavior before implementation:

- `src/model.ts` defines `createSchemas` as a boolean defaulting to true, in policy
  version 1 and document format 5.
- `src/prepare.ts` emits unconditional `CREATE USER` commands, followed by object
  reconstruction, under a fail-fast SQL*Plus preamble.
- `src/schema-owners.ts` collects distinct, sorted table, view, and index owners.
- `scripts/compose-destination.ts` rejects any existing selected owner during
  setup when creation is enabled. Disabling creation requires all owners to exist.
  This is the source of the reported error, before generated SQL is replayed.
- `scripts/clone-workflow.ts` maps indexed setup failures to actionable messages.
- Retry reuses saved SQL bytes; it does not regenerate SQL. Changing generation
  cannot retrofit previously generated bundles.

Primary Oracle documentation, accessed 2026-09-28:

- [CREATE USER](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/CREATE-USER.html)
  documents `IF NOT EXISTS`: missing users are created and existing users retained.
  The Oracle 23 documentation URL currently redirects to this Oracle 26 page.
  Compatibility with the repository's pinned Oracle image must therefore be
  verified by integration tests before shipping.
- [ORA-01920](https://docs.oracle.com/en/error-help/db/ora-01920/) covers conflicts
  with either users or roles. Ignoring this error indiscriminately is insufficient:
  an existing role is not a usable schema.

Pinned-image verification found that native `CREATE USER IF NOT EXISTS` accepts
existing `SYS` and preserves user settings, but also silently skips a conflicting
role. The implementation therefore uses a user-only `ALL_USERS` check followed by
ordinary dynamic `CREATE USER`, with no exception suppression. The original native
rendering proposal was revised on this evidence.

## Decisions and Boundaries

- `createSchemas=true` means create missing owners and reuse existing owners.
- `createSchemas=false` continues to emit no user creation and require existing
  owners in local setup verification.
- Apply the same semantics to all selected owners, including `SYS`; skipping
  creation does not skip or authorize replacement of objects in that schema.
- Existing user settings are not reconciled with policy. Later object creation
  may still fail due to permissions, quotas, or object-name conflicts.
- Permission failures, role-name conflicts, invalid configuration, and unrelated
  SQL errors remain fatal. Never use global `WHENEVER SQLERROR CONTINUE` or swallow
  all exceptions.
- Keep current tablespace, MAX_STRING_SIZE, external-prerequisite, and final
  reconstruction checks. Do not relax the external-prerequisite policy rules.

## Oracle Example

Destination contains `SYS` and `APP_EXISTING`; `APP_NEW` is absent. Each owner
receives a block like this (with exact identifier and SQL-literal escaping):

```sql
DECLARE
  n NUMBER;
BEGIN
  SELECT COUNT(*) INTO n FROM ALL_USERS WHERE USERNAME = 'APP_NEW';
  IF n = 0 THEN
    EXECUTE IMMEDIATE 'CREATE USER "APP_NEW" NO AUTHENTICATION DEFAULT TABLESPACE "USERS" QUOTA UNLIMITED ON "USERS"';
  END IF;
END;
/
```

Existing accounts are preserved; `APP_NEW` is created. Subsequent generated
commands run subject to the existing fail-fast rules.

## Implemented Design

In `src/prepare.ts`, emit a PL/SQL block for each owner that checks `ALL_USERS`
and executes ordinary `CREATE USER` only when the exact user is absent. There
are no exception handlers: role conflicts, permission errors, and concurrent
creation conflicts remain fatal. Preserve identifier quoting, sorted
deduplication, tablespace and quota clauses, and the SQL preamble. Generation
remains offline and deterministic. The pinned image's native conditional syntax
was rejected because it silently skipped role-name conflicts.

In `scripts/compose-destination.ts`, omit owner-absence requirements when
`createSchemas=true`. When false, retain owner-existence requirements and their
messages. Keep `setupChecks` and error-detail mapping derived from the same
requirements array so removing entries cannot mislabel subsequent failures.

There are no JSON fields, type changes, or format/policy version bumps. Existing
valid source, target, and policy documents remain accepted. Regeneration of an
existing target yields the new conditional SQL. Existing SQL artifacts and retry
bundles retain their original bytes and may still fail on existing users; users
must generate a fresh bundle to obtain this behavior. Publication must never
overwrite old artifacts.

No conflict with ADR 0001 or ADR 0008: source access remains read-only, offline
stages remain offline, validation still gates generation, and destination writes
remain inside the existing orchestration boundary. No superseding ADR is needed.

## Implementation Plan

1. Verify native conditional creation on the pinned Oracle image, especially
   existing `SYS`, existing users with different settings, and role conflicts.
   If unsupported, stop and revise the rendering design; do not suppress errors
   broadly or silently raise the supported destination version.
2. After the native role-conflict test failed, revise rendering to the explicit
   user-only PL/SQL check above. Update schema rendering in `src/prepare.ts` and
   setup requirements in `scripts/compose-destination.ts` together.
3. Extend `test/pipeline.test.ts`, `test/cross-owner-indexes.test.ts`, and
   `test/clone-workflow.test.ts` for conditional SQL, exact identifiers, sorted
   unique owners, both policy values, and stable setup-error mapping.
4. Add Oracle coverage in `test/integration/local-clone.test.ts` and, as needed,
   `test/integration/cross-owner-indexes.test.ts`. Use only the explicit test
   Compose project and disposable fixture users/roles. Test `SYS` creation as an
   isolated no-op; do not create fixture objects under `SYS`.
5. Update `README.md` and `examples/clone.sql` to describe/default to conditional
   creation, retained user settings, unchanged object errors, and fresh-bundle
   requirements for retries.
6. Run `npm run typecheck`, `npm test`, and `npm run test:integration`.

## Test Plan and Acceptance Criteria

- [x] A mixed set of existing and missing schemas proceeds past setup, preserves
  existing users, creates missing users, and reconstructs fixture objects.
- [x] An existing user before a missing user in sorted order does not stop the
  remaining creation statements.
- [x] An isolated existing `SYS` creation statement succeeds without modification.
- [x] Existing authentication type, default tablespace, and quota remain unchanged.
- [x] Index-only and view owners receive the same conditional behavior.
- [x] Quoted identifiers remain exact and each owner is emitted once.
- [x] `createSchemas=false` emits no user creation and still rejects missing owners.
- [x] A conflicting role, insufficient privileges, and existing table errors
  remain failures; subsequent statements do not mask a failed reconstruction.
- [x] Tablespace and external-prerequisite errors retain correct indexed details.
- [x] Existing document contracts, deterministic generation, independent validation,
  read-only source access, and non-overwriting publication remain intact.
- [x] Retrying old SQL does not rewrite it or claim it gained conditional creation.

## Validation Results

- `npm run typecheck`: passed.
- `npm test`: 365 passed.
- `npm run test:integration`: 6 passed; the existing opt-in operational reset
  test was skipped. New conditional-creation coverage ran against the explicit
  test Compose destination on the pinned image.
- Changed TypeScript and snapshot files pass Prettier; `git diff --check` passes.

## Risks and Open Questions

No unresolved requester decisions. The revised user-only blocks have been verified
against the pinned image, including isolated `SYS` reuse and role conflicts.
Reusing an existing schema does not guarantee later object creation will succeed, and intentionally leaves its settings
unchanged. Old saved SQL remains strict until regenerated into a fresh artifact.
