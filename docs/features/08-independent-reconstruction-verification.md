# Feature: Independent reconstruction verification

- Status: Implemented — verification results below
- Date: 2026-09-24
- Priority: High
- Request: Detect fidelity regressions even when extraction repeats the same mistake.

## Context and Scope

Given source and reconstructed schemas, verification checks selected semantics
through independent catalog queries and behavior, in addition to model equality.
The default ALL_* extraction path is exercised with a restricted source account.

Affected components: unit tests, Oracle integration fixtures, and CI. Exclude
production source mutations and expansion of supported schema features.

Implementation was authorized by the subsequent `/goal` request for this plan.
The implementation retains the existing production API and supported subset.

## Research Findings

Verified: `test/integration/oracle-roundtrip.test.ts` extracts both sides using the
same adapter. Its normalizeExpression collapses whitespace inside literals and
counts parentheses without lexical awareness. Live extraction explicitly selects
DBA scope as SYSTEM. Offline catalog tests cover two cases; pipeline tests have no
focused view graph suite. Review baseline: 32 offline tests and typecheck passed;
live integration was not executed during the review.

Repository paths refer to the implementation reviewed on 2026-09-24. The review
passed `npm test` (32 tests) and `npm run typecheck`; live integration was inspected,
not executed.

## Decisions and Boundaries

Retain round-trip equality, but add independent evidence. No production JSON/API
change. Run any mutating verification only against disposable fixtures. Avoid
normalizing arbitrary SQL with regular expressions. GitHub Actions runs offline checks on pushes and pull requests, with a separate
manually dispatched disposable Oracle job.

Preserve read-only extraction, offline transform/validate/generate, trusted SQL
fragment boundaries, independent generation validation, deterministic ordering,
non-overwriting artifacts, and secret exclusion. Invariant exceptions: none proposed.

## Proposed Design

Add direct catalog assertions for restrictions, datatype parameters, ordered keys,
comments, object validity, and access requirements. Add behavior checks where
catalog equality is insufficient. Preserve literal text exactly; any normalization
must be quote-aware and restricted to justified presentation differences.

Create a fixture account with CREATE SESSION plus explicit required object grants,
then test default ALL_* extraction success and inaccessible-dependency failures.
Add focused view closure/cycle tests and catalog corruption fixtures. Introduce
required offline CI checks and a separately provisioned Oracle integration job.

## Implementation Plan

1. Add independent assertions and safe comparison helpers in
   `test/integration/oracle-roundtrip.test.ts`.
2. Extend `docker/oracle/source-init/01-seed.sql` with restricted-reader and boundary fixtures.
3. Add focused tests to `test/catalog.test.ts` and `test/pipeline.test.ts`.
4. Configure CI using npm ci, npm run typecheck, npm run build, and npm test;
   run npm run test:integration only with disposable Oracle services.
5. Document required checks and integration provisioning.

## Test Plan

Include literal strings containing repeated spaces, quotes, and parentheses;
read-only/check-option views; inaccessible FK/view dependencies; valid cycles only
where supported; long LONG values; scope isolation; and source/destination
independent expected values. Ensure new negative tests fail on the old behavior.

Run `npm test` and `npm run typecheck`. Run `npm run build` for module/interface
changes. Catalog or generated-SQL changes also require `npm run test:integration`
against disposable Oracle services.

## Acceptance Criteria

- [x] A repeated exporter defect cannot satisfy all fidelity assertions.
- [x] SQL literal changes remain visible to comparisons.
- [x] Default-scope extraction is verified using a restricted account.
- [x] Offline checks and a documented disposable Oracle test workflow are reproducible.
- [x] Existing pipeline invariants and stated compatibility behavior remain covered.
- [x] README and relevant architecture decisions describe the final behavior.

## Risks and Open Questions

The Oracle workflow uses ubuntu-24.04; allocate 16 GiB RAM for two databases and
sufficient image/volume disk. Use a larger runner if necessary. Repository settings
must require the offline check; Oracle integration is manual. Hosted workflow
execution and branch-protection setup are not performed by local implementation.
Independent expectations are handwritten from fixture DDL, not adapter output.

## Implementation and verification

- Added direct, fixed source/destination catalog expectations and destination DML
  assertions, while retaining round-trip equality and existing restriction probes.
- Replaced unsafe expression normalization with a test-only quote-aware tokenizer;
  regression cases distinguish literals that the previous helper collapsed.
- Added numeric/character/literal boundary columns and passwordless proxy readers.
  Default ALL extraction uses explicit SELECT grants; limited visibility must fail
  for FK and view dependencies. Source verification performs no mutations.
- Extended long LONG text, default scope isolation, and diamond/cycle extraction
  coverage; existing corruption tests and semantic graph tests remain in place.
- Added GitHub Actions workflows, README provisioning guidance, and ADR 0006.

Validation: 126 offline tests passed; TypeScript typecheck and build passed.
All 3 live Oracle integration tests passed against the disposable Compose pair
(Oracle Free; catalog-reported version 23.0.0.0.0). Formatting and git diff checks
also passed. Hosted GitHub Actions execution was not performed.
