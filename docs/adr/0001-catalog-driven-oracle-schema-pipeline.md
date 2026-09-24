# ADR 0001: Catalog-driven Oracle schema reconstruction pipeline

- Status: Accepted
- Date: 2026-09-23
- Owners: Repository maintainers

## Context

The application must reconstruct a selected relational slice of an Oracle schema
without treating source DDL as portable input. Oracle-generated DDL can contain
storage, environment, and object details that are unsuitable for the destination.
The workflow must also remain inspectable, deterministic, safe for the source
database, and usable offline after extraction.

The requested slice consists of explicitly selected tables and the tables they
directly reference. It is not a database backup. Data and unrelated schema objects
are outside the application's scope.

## Decision

Use a four-stage, catalog-driven pipeline with a strict, versioned JSON intermediate
representation:

```text
Oracle catalog + tables.json
          |
       extract
          v
     source.json
          |
 transform + policy.json
          v
 target.json + report.json
          |
       validate
          v
   diagnostics / gate
          |
       generate
          v
       clone.sql
```

Only `extract` connects to Oracle. It queries catalog facts through the `oracledb`
Thin driver and never calls `DBMS_METADATA.GET_DDL`. The remaining stages operate
on local files.

The stages have these responsibilities:

1. `extract` captures exact identifiers, ordered columns, Oracle datatypes,
   constraints, indexes, physical provenance, prerequisites, and source metadata.
   It includes each selected table plus its direct FK parents. Parent tables do
   not recursively expand the selection.
2. `transform` applies a versioned target policy without mutating the source
   document. It removes outgoing FKs from parent-only tables, chooses destination
   storage behavior, and records every deliberate change.
3. `validate` checks document shape, references, semantic consistency, supported
   Oracle features, target limits, and acknowledged external prerequisites.
4. `generate` validates again, then emits ordered Oracle 23 SQL for schemas,
   tables, indexes, local constraints, cross-schema grants, and retained FKs.

The JSON schemas in `src/model.ts` are the contract. Documents use
`formatVersion: 1`, strict runtime validation, a `kind` discriminator, and exact
Oracle object references as separate `owner` and `name` values. SQL expressions
remain trusted Oracle fragments rather than parsed expression trees.

Generation is fail-closed. Unsupported or inconsistent structures produce
diagnostics and block SQL instead of being approximated. Generated artifacts never
overwrite existing files. Passwords come from a hidden prompt or
`ORACLE_PASSWORD`, never CLI arguments or artifacts.

## Scope

The accepted scope is ordinary, nonpartitioned Oracle heap-table reconstruction,
including supported scalar columns, identities, defaults, virtual and invisible
columns, PK/UK/check/not-null/FK constraints, and conventional supported indexes.

The pipeline intentionally excludes application rows, views, standalone sequences,
triggers, stored programs, synonyms, jobs, comments, security policy, original
grants, statistics, and complete physical configuration. External prerequisites
are declared and acknowledged, not exported recursively.

## Invariants

Changes must preserve these properties unless a later ADR explicitly replaces
them:

- Source access remains read-only; only extraction connects to Oracle.
- The source model remains an unchanged record of extracted facts.
- Selection remains explicit and one-hop unless a versioned behavior changes it.
- Intentional omissions appear in a report.
- Validation gates generation and generation independently revalidates.
- Unknown fields, versions, states, and unsupported features fail explicitly.
- Object and composite-column ordering remains deterministic.
- Existing output files are never overwritten.
- Secrets never enter command arguments or generated artifacts.

## Consequences

Benefits:

- Extraction, policy, validation, and rendering can be tested independently.
- Most development and review require no live Oracle instance.
- Versioned artifacts provide provenance and an audit trail.
- Explicit rejection reduces the risk of silently incorrect SQL.

Costs:

- Supporting a new Oracle feature may require coordinated catalog, model,
  validation, transformation, generation, fixture, and integration-test changes.
- Catalog queries do not provide a single point-in-time schema snapshot.
- Stored SQL fragments must come from trusted sources.
- This is deliberately narrower than a general migration or backup tool.

## Requesting additional features

Create a request from [`docs/feature-request.md`](../feature-request.md). Copy the
template into an issue, pull-request description, or chat request and fill every
required section. Use one externally observable capability per request.

Requests are evaluated in this fixed order:

1. Define the input and expected output with a concrete Oracle example.
2. State which pipeline stages change: extract, transform, validate, generate.
3. Identify effects on the versioned JSON contract and compatibility.
4. State behavior for unsupported, ambiguous, or inaccessible metadata.
5. Add acceptance criteria and the required unit/integration fixtures.
6. Check every invariant above; propose a superseding ADR for any exception.

A request is implementation-ready when its example, scope, failure behavior,
compatibility decision, and acceptance criteria are unambiguous.

## Alternatives considered

- Replay `DBMS_METADATA` output: rejected because it couples extraction to DDL
  rewriting and carries source-specific decisions into the target.
- Generate SQL directly during extraction: rejected because it removes the
  reviewable model, offline policy step, and independent validation gate.
- Recursively export every dependency: rejected because it makes selection and
  operational scope unpredictable.
- Best-effort generation: rejected because silent approximation is unsafe for
  schema semantics.

