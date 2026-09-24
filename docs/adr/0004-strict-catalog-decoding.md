# ADR 0004: Strict catalog decoding and view restriction ownership

- Status: Accepted
- Date: 2026-09-24

## Decision

Runtime Zod decoders separate Oracle transport from domain assembly. Every selected
field is checked before conversion. Explicit enums prevent unknown/null flags from
becoming false or default states. Unique identities and contiguous ordered members
are checked before Map assembly or position renumbering. Internal table column IDs
may legitimately have gaps, so they require uniqueness rather than contiguity.
Stable catalog errors contain object/field context; no raw row or SQL fragment is
included. Result sets are closed even when fetching or decoding fails.

The requester approved format v4 and mandatory re-extraction on 2026-09-24.
This supersedes ADR 0003's v3 compatibility statement. Both document schemas reject
older versions; there is no automatic migration because old descriptive view facts
can be false. Selection and policy versions do not change.

The complete catalog view TEXT owns restriction SQL. Read-only and check-option
fields describe catalog facts and never append clauses. READ_ONLY is cross-checked
against constraint type O. Constraint type V maps to CASCADED, absence to NONE.
LOCAL remains a representable descriptive value for authored artifacts; extraction
never invents it. More than one restriction or inconsistent metadata fails closed.
Existing semantic validation still rejects mutually exclusive restriction flags.
No SQL parsing or stripping is introduced, and named restriction constraints are
not separately reconstructed when Oracle omits their names from TEXT.

## Evidence and scope

Read-only probes against Oracle AI Database Free 23.26.3.0.0 found WITH READ ONLY
and WITH CHECK OPTION inside DBA_VIEWS.TEXT, including views originally created
with named constraints. DBA_CONSTRAINTS independently exposed O/V rows. Integration
coverage includes ordinary views, both restriction types, workbook facts, direct
catalog checks after replay, and DML acceptance/rejection. This is the verified live
version; older releases are not integration-certified by this change.

Oracle documents [READ_ONLY](https://docs.oracle.com/en/database/oracle/oracle-database/21/refrn/ALL_VIEWS.html)
and [O/V constraint types](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_CONSTRAINTS.html).
References accessed 2026-09-24; documentation alone does not establish TEXT ownership
on every release.

## Consequences

Re-extract v3 artifacts rather than relabeling them. Workbook facts now reflect
restrictions while replay emits syntax exactly once. Trusted SQL remains opaque;
authors must keep SQL and descriptive facts consistent. All other invariants remain:
read-only source access, explicit catalog scope, offline later stages, independent
generation validation, deterministic output, secret exclusion and no overwrites.
