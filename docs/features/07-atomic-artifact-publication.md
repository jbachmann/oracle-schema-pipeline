# Feature: Atomic artifact publication and completion tracking

- Status: Draft request — captured from architecture review; not approved for implementation
- Date: 2026-09-24
- Priority: High
- Request: Expose only complete artifacts and make multi-file completion unambiguous.

## Context and Scope

Given concurrent writers or an interrupted write, existing artifacts remain
unchanged and a final pathname never exposes partially copied contents. Given a
failed transform report write, consumers can distinguish incomplete output sets.

Affected components: artifact writer and CLI across all stages, including dictionary.
Exclude database transactions and overwriting/replacing existing artifacts.

This request captures the user's authorized review recommendations. Design defaults
below are proposals, not approved implementation decisions. Implementation has not
started. Resolve material open questions before promoting this request to Planned.

## Research Findings

Verified: `src/files.ts` fsyncs a partial file then uses COPYFILE_EXCL; this prevents
overwriting but does not establish atomic publication. `src/cli.ts` writes target
and report sequentially. The README documents that they are not an atomic pair.

Node explicitly disclaims atomicity of copyFile. Primary source, accessed 2026-09-24:
[Node filesystem API](https://nodejs.org/download/release/v26.3.0/docs/api/fs.html).

Repository paths refer to the implementation reviewed on 2026-09-24. The review
passed `npm test` (32 tests) and `npm run typecheck`; live integration was inspected,
not executed.

## Decisions and Boundaries

Preserve no-overwrite semantics and existing artifact payload formats. Proposed
default: stage in a configurable temporary directory, defaulting to a location
within the CLI's current working directory, and publish with an exclusive
atomic operation; do not silently fall back to copying. A completion manifest is
proposed for multi-artifact output, not a claim that separate pathnames become one
filesystem transaction. Filesystem support and manifest rollout remain open.
The staging directory must be on the same filesystem as each destination it serves;
reject incompatible locations before writing artifacts.

Preserve read-only extraction, offline transform/validate/generate, trusted SQL
fragment boundaries, independent generation validation, deterministic ordering,
non-overwriting artifacts, and secret exclusion. Invariant exceptions: none proposed.

## Proposed Design

Make the temporary-file directory configurable. When not configured, use a
dedicated temporary subdirectory within the current working directory from which
the CLI is invoked. Resolve relative configured paths against that working
directory. The exact CLI option and default subdirectory name remain to be defined.
Preflight that staging and destination locations share a filesystem; if they do
not, fail with an actionable diagnostic directing the user to configure a
compatible temporary directory. Do not fall back to copying or silently select a
different staging location.

Use a completed, synchronized temporary file and a tested exclusive publication
primitive, such as a same-filesystem hard link where supported. Specify directory
synchronization, temporary-file ownership, cleanup, and post-publication cleanup
failure separately. A cleanup failure must not misreport a committed file as absent.

Preflight all destinations, including report and completion paths; reject aliases
that resolve to the same output. Keep final exclusive publication as the race guard.
Proposed manifest fields: version, artifact roles, paths, byte lengths, and content
hashes. Publish it last. Its schema is independent of source/target formatVersion.
Proposed error codes: OUTPUT_EXISTS, OUTPUT_PATH_CONFLICT,
OUTPUT_PUBLICATION_UNSUPPORTED, OUTPUT_INCOMPLETE.

## Implementation Plan

1. Define supported filesystems, temporary-directory configuration and default
   subdirectory name, and completion-manifest interface.
2. Add fault-injection and concurrency cases in `test/files.test.ts`.
3. Replace copying in `src/files.ts` with the selected publication protocol.
4. Add multi-output coordination and destination preflight in `src/cli.ts`.
5. Update README recovery guidance and consumers that require complete output sets.

## Test Plan

Verify bytes for JSON, SQL, and XLSX; existing destination preservation; competing
writers; interrupted staging/publication; stale temporary files; unsupported link
operations; cleanup errors; report failure; path aliases; and absent completion
manifest for every incomplete bundle. Verify the working-directory default,
absolute and relative configured temporary directories, and rejection of staging
locations on a different filesystem from their destinations. Distinguish crash
durability from visibility.

Run `npm test` and `npm run typecheck`. Run `npm run build` for module/interface
changes. Catalog or generated-SQL changes also require `npm run test:integration`
against disposable Oracle services.

## Acceptance Criteria

- [ ] A reader never observes partial contents at a published final pathname.
- [ ] Existing output cannot be replaced, including during races.
- [ ] Temporary-file location is configurable and defaults to a subdirectory of
      the CLI's current working directory.
- [ ] Staging locations on a different filesystem from their destinations are
      rejected before writing artifacts, with configuration guidance.
- [ ] Failed bundles never receive a completion manifest.
- [ ] Retry and cleanup behavior is documented and tested.
- [ ] Existing pipeline invariants and stated compatibility behavior remain covered.
- [ ] README and relevant architecture decisions describe the final behavior.

## Risks and Open Questions

Approve supported filesystem/platform scope and whether manifests are opt-in or
default before finalizing the CLI contract. Hard-link and directory-sync behavior
needs platform-specific verification; atomic visibility alone is not power-loss durability.
