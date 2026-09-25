# ADR 0005: Atomic artifact publication and completion manifests

- Status: Accepted
- Date: 2026-09-24

## Decision

Preserve ADR 0001's no-overwrite invariant using exclusive hard-link publication
of a completed, synchronized, closed staging file. Do not copy into final paths
or fall back to replacing renames. Support local filesystems that provide atomic
exclusive hard links. Network filesystems are outside the guarantee. Local macOS
execution is verified; other deployments must verify their filesystem semantics.

All writing commands accept `--temp-dir`, resolving relative paths against the
invoking working directory and defaulting to `.oracle-schema-tmp` there. Create
private unique `publication-*` directories and mode-0600 files. Check every
resolved destination parent device against staging before writing artifact bytes.
Reject existing paths (including dangling symlinks) and destination aliases;
case/Unicode-normalization variants in the same directory are conservatively
conflicting even on case-sensitive filesystems. Destination directories must stay
stable and trusted throughout publication. Exclusive linking remains the race
protection after preflight.

Stage every bundle member before publishing any member. Transform always publishes
a version-1 manifest last, at `<output>.complete.json` or `--completion`. Its
ordered `artifacts` entries have `role` (target, report), canonical absolute `path`,
`bytes`, and lowercase hexadecimal `sha256`. This version is independent of model
formatVersion. File formats and semantic error exit codes are unchanged. A complete
bundle with blocking diagnostics still has a manifest and exits 2.

Consumers that require a complete set verify the manifest against their expected
roles and paths and check lengths and hashes. The clone workflow performs this
verification before using the target. Independent validate/generate commands still
accept individual model files and revalidate their semantics.

## Consequences

Atomic visibility is per pathname, not a multi-path transaction. A failure after
publishing a subset reports OUTPUT_INCOMPLETE and never publishes a completion
manifest. Retry with fresh names; never overwrite or remove already published
artifacts as rollback. Preflight failures publish nothing; existing paths report
OUTPUT_EXISTS and aliases report OUTPUT_PATH_CONFLICT. Unsupported hard-link or
cross-device publication reports OUTPUT_PUBLICATION_UNSUPPORTED.

Attempt destination-directory synchronization after each committed link. Failure
produces OUTPUT_DURABILITY_WARNING rather than claiming the file was not published.
Power-loss durability is platform dependent and not guaranteed. Cleanup only
removes the invocation's private staging directory; failures produce
OUTPUT_CLEANUP_WARNING without changing a committed outcome. A killed process may
leave staging files, including hard links to published files. Never edit these;
remove the owned directory only after verifying its process has stopped. Stale
directories neither block retries nor get adopted by later invocations.

No database access, trusted SQL fragment boundary, generation validation rule, or
source/target payload format changes. The new manifest is an additional artifact.

## Evidence

Filesystem fault injection, competing writers, real SIGKILL interruption at staging
and publication, retry ownership, alias and cross-device rejection, manifest
ordering/failures, consumer verification, and JSON/SQL/XLSX byte checks are covered
by files, completion, and publication CLI tests. These test visibility and recovery;
they do not simulate power loss.

Node's [filesystem API](https://nodejs.org/api/fs.html#fspromiseslinkexistingpath-newpath)
exposes hard-link creation; unlike copying, publication introduces a name for the
already completed inode. The design relies on the filesystem's exclusive atomic
link semantics, not a Node-level multi-file transaction.
