# ADR 0009: Explicit programs and supporting-object reconstruction

- Status: Accepted
- Date: 2026-09-28
- Implements: [Feature 21](../features/21-explicit-program-dependency-reconstruction.md)

## Decision

Format 6 captures explicitly selected ordinary PL/SQL procedures, functions,
whole package specifications and existing bodies, conventional global sequences,
and local private synonyms. Selection version 3 has seven collections; strict
version-2 relational selections remain accepted. Policy version 2 adds explicit
object grants and sequence-start overrides; version-1 policy input normalizes to
empty additions. Old artifacts require re-extraction, including retry bundles.

This supersedes ADR 0001's stored-program, standalone-sequence and synonym
exclusions and previous format statement. Exact catalog source is trusted
application content. A bounded lexer binds the top-level declaration to its
catalog identity; the remaining source is preserved. This does not authorize
DBMS_METADATA extraction, general source rewriting, or source execution.

An operation graph supersedes ADR 0003's relational-only dependency-kind and
fixed-order rules. Table dependencies remain distinct from index dependencies.
The graph orders schemas, sequences, aliases, tables, views, indexes, constraints,
compilation units, and effective grants. Package compilation references resolve
to specifications; call-capable DDL also requires existing bodies. Aliases may be
created before their target, but consumers require their resolved provider.
Genuine cycles fail rather than using FORCE, stubs, or repeated compilation.
Relational closure remains one-hop FK expansion and recursive table/view closure;
program and alias references do not recursively select exported objects.

Sequence reconstruction deliberately restarts at MINVALUE for ascending sequences
or MAXVALUE for descending sequences, unless policy supplies an in-range override.
Exact decimal strings and BigInt preserve integer parameters. LAST_NUMBER is
provenance only. Extraction and operational verification never consume values.
Identity backing sequences remain exclusively reconstructed by identity clauses.

Private synonym mappings and external chain-resolution facts remain exact.
Acknowledgment does not confer privileges or provision objects. Grants target
base objects, require included grantees, and are limited to the explicit privilege
allowlist. Existing index/view/FK grants remain inferred. External prerequisites
still require createSchemas=false and manual setup.

Programs are transported through bounded CLOB chunks and parsed once with
DBMS_SQL. The wrapper restores session compiler settings and releases cursor/LOB
resources on success and failure. Target compiler policy uses INTERPRETED,
ENABLE:ALL warnings, and IDENTIFIERS:NONE. Semantic compiler settings are retained.
SQL*Plus replay uses UTF-8. Creation and final assertions reject compilation
errors, missing units, incorrect sequence/synonym definitions, and missing grants.
Body absence requires owning-schema or explicitly selected DBA authority.

ADR 0008's destination boundary is unchanged. Extraction remains catalog-only;
offline stages independently validate before non-overwriting publication. Replay
and verification never deliberately invoke business routines. DDL containing
function expressions can implicitly execute code or initialize packages. Trusted
stored code is not sandboxed. Types, infrastructure, triggers, dynamic SQL,
runtime identity privileges, and application rows remain manually supplied and
successful reconstruction does not prove runtime equivalence.

## Verification

The pinned test image is Oracle AI Database Free 23.26.3.0.0 and reports
23.0.0.0.0 through PRODUCT_COMPONENT_VERSION.
`test/scripts/program-probes.sql` verifies source
headers/newlines, public overloads and no-argument routines, body-less constants,
immediate alias edges, exact 28-digit sequence values, KEEP, descending values,
available Boolean conversion settings, and CLOB parsing above 32 KiB.
A separate pinned-image probe rejected CACHE 1 with ORA-04010; validation keeps
that destination limit even where newer Oracle documentation differs.

Oracle stores a literal `NULL` in ordinary SQL_MACRO/POLYMORPHIC member fields,
but SQL null in package-level rows. Constants-only package AUTHID may be null;
the declaration establishes its effective default. ALL_SOURCE strips CREATE and
blanks qualified owner text; rows must be concatenated without inserting newlines.
Boolean ALTER SESSION values require keyword syntax. SQL*Plus's default client
character set is insufficient for Unicode source; operational replay explicitly
sets NLS_LANG=.AL32UTF8.

Older program catalog releases without the required capability metadata fail
closed until verified. No legacy Boolean setting is guessed. ALL visibility
cannot establish another owner's absent package body, even if its specification
is visible. Additional independent coverage lives in
`test/integration/program-dependencies.test.ts`.

Generated explicit-grant assertions use DBA_TAB_PRIVS: the pinned SYS session's
ALL_TAB_PRIVS does not expose grants between all other schemas. Replay of explicit
grants therefore requires dictionary visibility; the local executor supplies it.
Synonym setup checks only external links and external terminals. Selected links
and terminals are verified after creation, avoiding a premature setup requirement.
