# ADR 0009: PL/SQL source reconstruction

- Status: Accepted
- Date: 2026-09-28

## Decision

Supersede ADR 0001's stored-program exclusion. Selection v3 adds standalone
procedures, public package procedures, and whole packages. Selecting a member
includes the entire specification and body, all overloads, private helpers, and
initialization. Standalone functions are dependency objects only. Strict selection
v2 retains its existing scope. Source and target format 6 records the selection
version, program roots, source lines, compilation settings, and dependency facts;
older artifacts require fresh extraction.

Program roots recursively follow recorded local TABLE, VIEW, PROCEDURE, FUNCTION,
and PACKAGE edges. Both package units contribute dependencies. Tables reached
through programs do not expand foreign keys. Explicit tables retain one-hop FK
parents, and unrelated legacy roots retain their original dependency scope. Roles
are target, direct-parent, view-dependency, then program-dependency. Oracle-maintained
objects are classified using catalog metadata and remain platform requirements.
Remote edges block generation; unsupported local objects require explicit external
provisioning and acknowledgement. Missing supported metadata cannot be silently
reclassified as an external prerequisite.

Capture ordered catalog source without DBMS_METADATA, source writes, compilation,
or calls. A narrow lexer recognizes the declaration and unsupported variants;
only the declaration identifier is qualified. Reject wrapped, external-language,
conditional-compilation, and editions-enabled-owner semantics. Preserve AUTHID,
editionability, and supported compiler settings. Source is trusted metadata and
may contain application literals; diagnostics never expose source text.

Independent validation recomputes reachability, namespace, roles, unit completeness,
and grants. Policy v2 adds explicit table/view grants for cross-owner program
access; direct program-to-program EXECUTE grants are derived. Neither grants nor
catalog edges prove runtime completeness. Always report runtime limitations.

An operation graph orders tables, keys, views, program units, indexes and grants.
Package compilation normally depends on specifications; executable function-based
indexes also depend on bodies and their executable closure. Self-recursion is
permitted; cycles requiring temporary invalid objects fail closed. Ordinary CREATE
never replaces an existing object. Bounded strings reconstruct complete DDL in a
CLOB for DBMS_SQL.PARSE, with resource cleanup on failure. Per-unit and final
catalog checks require VALID status and no compiler errors without calling business
entry points. Compiler diagnostics expose identity and numeric context only.

## Consequences

ADR 0003's internal TABLE/VIEW dependency restriction now also permits included
programs. ADR 0007 event v1 adds program, program-source, program-members,
program-settings, and program-dependencies query categories; source, settings and
binds remain excluded from events. ADR 0008's fixed local destination boundary,
locking, reset safeguards and immutable artifacts are unchanged.

Transform, validation and generation remain offline. Retry accepts only the current
format and exact preamble and rejects old bundles before reset. It never rewrites
saved SQL. Large packages can greatly increase extraction size. Dynamic SQL,
invoker-specific runtime references, omitted dependency-table FKs, and absent data
limit behavioral equivalence. Compilation verifies deployment, not application
behavior or privilege minimality. Conditional compilation and cyclic compilation
support remain deliberately excluded.
