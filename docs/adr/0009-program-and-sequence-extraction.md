# ADR 0009: Explicit program and sequence reconstruction

- Status: Accepted
- Date: 2026-09-29
- Supersedes: ADR 0001 only for program/standalone-sequence exclusion, the blanket GET_DDL prohibition, and document format.

## Decision

Selection version 2 additionally accepts packages, procedures, functions and
sequences. Documents use strict format 6; older artifacts must be re-extracted,
including retry artifacts. Policy and completion-manifest versions are unchanged.
Programs and sequences are explicitly selected, without recursive export of their
dependencies. Existing table/view closure rules are unchanged.

Only extraction connects to the source. It reads separate DBMS_METADATA.GET_DDL
CLOBs for package specifications, existing bodies, procedures and functions.
Metadata transforms are reset to defaults, SQLTERMINATOR is enabled, and defaults
are restored in finally. This narrowly permits session metadata settings; source
compilation, application execution and NEXTVAL remain forbidden. Complete package
visibility requires ownership, or DBA catalog scope with SYS authority or enabled
SELECT_CATALOG_ROLE. ALL scope cannot prove cross-owner body completeness.
There is no source-text fallback or automatic privilege elevation.

Program DDL is trusted executable input, preserved exactly through offline stages.
It is not parsed, sandboxed, redacted, remapped or reflowed. Operators must exclude
embedded credentials from programs intended for publication. The existing physical
SQL line limit applies. SQL*Plus runs with UTF-8 when used by local orchestration.

Sequence bounds, increments and cache sizes remain decimal strings with BigInt
validation. Reconstructed sequences start at the minimum for positive increments,
or maximum for negative increments; source position and historical START WITH are
not captured. Identity-owned sequences belong to their table. Oracle-maintained,
application-common and sharded sequences are rejected. The pinned standalone image
rejects even NOSHARD (ORA-02511), so ordinary sequence SQL omits that clause.
Inconsistent or unverified combinations fail closed.

Included definitions satisfy typed dependencies. Oracle-maintained program
references remain recorded without recursive export. External application objects
and cross-owner program access require explicit acknowledgement and operator
prerequisite SQL. Dependency rows do not identify DML privileges: the pipeline does
not infer broad grants. Existing narrow index/view grants are retained; known
cross-owner table defaults receive sequence SELECT grants, and modeled table
expressions receive EXECUTE on their selected function/package.

Creation follows modeled dependencies. Pure program cycles may be temporarily
invalid; cycles involving table expressions or views fail before publication.
Package-body cycles use their independently created specifications. Standalone
cycles that Oracle cannot compile without stubs fail the validity gate; no
replacement program text or stubs are synthesized.
Selected units are compiled in bounded passes and checked individually for existence
and VALID status. No whole-schema compilation or application execution is emitted.
Pinned-image replay verified ORA-24344 as a compilation warning that SQL*Plus can
continue past. The loop handles only that code and propagates every other error.
Final failures carry OSP_PROGRAM_INVALID; compilation does not prove runtime behavior.

## Consequences

Source reads remain read-only, subsequent stages remain offline, owner names are
preserved, generation revalidates, and artifacts are never overwritten. Local clone
verification covers every selected unit and exact package-body presence. Dynamic
SQL dependencies, runtime privileges, package initialization and cross-release
PL/SQL portability remain outside the guarantee. Workbooks show counts for new
objects while retaining table/view sheets and excluding program DDL.

## Evidence

Oracle integration tests exercise full CLOBs over 32 KB, owner and cross-owner
metadata access, restricted-reader rejection, spec-only packages, invalid programs,
sequence configuration/reset and destination-only behavior probes. See
`test/integration/programs-and-sequences.test.ts`.

Catalog prerequisites retain TABLE/INDEX origin so table creation does not wait
on programs used only by a deferred index. Manually authored prerequisites without
origin are conservatively treated as table requirements. Constraint creation can
invalidate earlier views/programs on Oracle; a dependency-ordered compilation pass
runs after constraints before final selected-program checks.

Oracle also omits virtual-column function relationships in tested ALL_DEPENDENCIES
rows. These opaque-expression dependencies require explicit, independently known
prerequisite facts in the reviewable document. The extractor does not invent them
or parse expressions. Integration coverage demonstrates rejection during replay
without the missing fact and correct order/direct EXECUTE with that fact supplied.
