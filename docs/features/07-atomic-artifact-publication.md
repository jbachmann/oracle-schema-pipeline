# Feature: Atomic artifact publication and completion tracking

- Status: Implemented
- Date: 2026-09-24
- Priority: High
- Request: Expose only complete artifacts and make multi-file completion unambiguous.

## Context and Scope

Concurrent writers and interrupted writes must preserve existing artifacts and
never expose partially copied bytes at final pathnames. Failed transform bundles
must be distinguishable from complete output sets. This applies to the artifact
writer and every CLI stage, including dictionary. Database transactions and
replacement of existing artifacts are excluded.

The requester approved default completion manifests at `<output>.complete.json`
and support for local disks with atomic exclusive hard links, with errors on
unsupported publication and no portable power-loss durability guarantee.

## Decisions and Boundaries

The implementation is specified in [ADR 0005](../adr/0005-atomic-artifact-publication.md).

- All writing commands accept `--temp-dir`. Relative paths resolve against the
  invoking working directory. The default is `.oracle-schema-tmp` there.
- Preflight every destination, including transform report and completion paths,
  against existing files, aliases, and the staging filesystem device. Reject
  incompatible staging with `OUTPUT_PUBLICATION_UNSUPPORTED` and `--temp-dir`
  guidance before staging any artifact bytes. Never switch staging or copy.
- Use private unique `publication-*` directories and exclusive mode-0600 staged
  files. Synchronize and close every bundle member before linking any final path.
- Publish with exclusive hard links on local filesystems that provide atomic
  linking. Existing paths are never replaced, including during races. Case and
  Unicode-normalization variants in one directory are conservatively rejected.
  Parent directories must remain stable and trusted during the operation.
- Attempt destination-directory sync after each link. A sync warning records
  reduced durability without claiming a committed file is absent. This protocol
  guarantees visibility, not survival of power loss on every platform.
- Clean up only the invocation's own temporary directory. Cleanup warnings preserve
  committed outcomes. Killed writers can leave temporary files; retries ignore
  those files. Remove stale directories only after their process has stopped, and
  never edit staged files that might share an inode with a published artifact.
- Transform publishes target, report, then a default completion manifest. Use
  `--report` and `--completion` to customize paths. The version-1 manifest contains
  ordered roles, canonical absolute paths, byte lengths, and SHA-256 hashes. Its
  version is independent of model formatVersion. A complete bundle can contain
  semantic errors and still exits 2; I/O failures exit 1.
- Failure after a published subset reports `OUTPUT_INCOMPLETE` and publishes no
  manifest for that bundle. Use fresh target, report, and completion paths on retry.
  This is completion tracking, not a multi-path filesystem transaction.
- `verifyCompletion` validates the expected roles and paths and the actual bytes;
  the clone workflow uses it before consuming the transform result. Independent
  validate/generate remain compatible with existing individual model files.

Read-only extraction, offline downstream stages, trusted SQL fragments, independent
generation validation, deterministic payloads, and secret exclusion are unchanged.
No source/target payload schema or generated SQL changes are introduced.

## Implementation

1. `src/files.ts`: staging configuration, destination preflight, synchronized
   exclusive publication, bundle manifests, committed-state warnings, and cleanup.
2. `src/cli.ts`: preflight all stage outputs and coordinate transform publication.
3. `src/completion.ts`: strict manifest and expected artifact verification.
4. `scripts/clone-compose-database.ts`: verify the complete transform bundle before
   validation/generation.
5. README and ADR 0005: supported storage, compatibility, manifest consumption,
   synchronization limits, retry, and cleanup guidance.

## Validation Evidence

- `test/files.test.ts`: Unicode JSON and binary byte preservation; complete SQL
  under competing writers; staging failure; unsupported links; cleanup failure;
  symlink, case and Unicode aliases; cross-device preflight; last-manifest ordering
  and exact hashes; failures at every publication position; pre-existing report
  and completion preservation; directory-sync warnings; real SIGKILL during
  staging and publication; stale-directory ownership and successful retries.
- `test/publication-cli.test.ts`: default/relative/absolute staging from the
  invoking directory; readable XLSX files; default/custom transform manifests;
  generated SQL byte equality; existing/aliased report and completion preflight;
  semantic-error bundles, validation reports, and independent SQL rejection.
- `test/completion.test.ts`: reject missing manifests/artifacts and mismatched
  versions, roles, paths, lengths, hashes, and member counts.
- `npm test`: 120 tests pass, including existing pipeline invariant coverage.
- `npm run typecheck` and `npm run build`: pass.
- `git diff --check`: pass.
- Oracle integration is not required for this change: catalog access and generated
  SQL semantics are unchanged. The database clone workflow's verification call is
  typechecked; no live clone was executed.

## Acceptance Criteria

- [x] A reader never observes partial contents at a published final pathname.
- [x] Existing output cannot be replaced, including during races.
- [x] Temporary-file location is configurable and defaults to a subdirectory of
      the CLI's current working directory.
- [x] Staging locations on a different filesystem from their destinations are
      rejected before writing artifacts, with configuration guidance.
- [x] Failed bundles never receive a completion manifest.
- [x] Retry and cleanup behavior is documented and tested.
- [x] Existing pipeline invariants and stated compatibility behavior remain covered.
- [x] README and relevant architecture decisions describe the final behavior.

## Verification Limits

Local macOS execution verifies the hard-link and directory-sync protocol in this
environment. Network filesystems are outside the guarantee; other deployments must
verify their filesystem semantics. Cross-device and unsupported-operation rejection
are tested through injected filesystem boundaries. Process termination tests do
not simulate hardware failure or establish power-loss durability.

Node's [filesystem API](https://nodejs.org/api/fs.html#fspromiseslinkexistingpath-newpath)
provides hard-link creation. The previous copying implementation prevented
replacement but did not provide the required atomic publication guarantee.
