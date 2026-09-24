# ADR 0002: Preserve table and column comments

- Status: Accepted
- Date: 2026-09-24

## Decision

Capture native Oracle comments for every included table and modeled user-generated
column from `DBA_TAB_COMMENTS` and `DBA_COL_COMMENTS`. Preserve present text exactly
and represent absence as `null`. Emit comments after tables and before indexes.

Source and target documents move to `formatVersion: 3`; v2 artifacts require
re-extraction. The version 2 selection document is unchanged. Missing, duplicate,
inconsistent, or unrenderable comment metadata fails closed.

Long and multiline values use bounded PL/SQL dynamic DDL so generated physical
lines retain the 2,400-byte SQL*Plus limit without altering stored text.

## Scope

This supersedes only ADR 0001's comment exclusion and document format-version
statement. Schema comments, view comments, view-column comments, annotations, and
comments on other object types remain excluded. Every other ADR 0001 invariant
remains in force.

## Consequences

Extraction requires read access to both comment catalog views. Transform,
validation, and generation remain offline. Comment text receives no target policy
or normalization. Cross-character-set replay can still fail visibly at Oracle.
